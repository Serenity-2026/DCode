import type { AgentEvent, AgentState, RegisteredTool } from '../domain/agent'
import type { AgentTool, LlmMessage } from '../domain/llm'
import type { ModelConfig } from '../domain/model-config'
import { toolValidator } from '../infrastructure/tool-schema'
import { AgentLoop } from './agent-loop'

/** 独立 Agent 运行时，拥有消息、工具、取消与生命周期；不依赖会话存储或 Electron。 */
export class Agent {
  private readonly tools: RegisteredTool[]
  private readonly listeners = new Set<(event: AgentEvent) => void>()
  private readonly current: AgentState
  private active?: { controller: AbortController; done: Promise<void> }

  /** 装配循环和可信工具，启动时复制声明并编译参数校验。 */
  constructor(private readonly loop: AgentLoop, tools: AgentTool[]) {
    if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error('工具名称重复。')
    this.tools = tools.map(tool => {
      const copy = { name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters), execute: tool.execute.bind(tool) }
      return { tool: copy, validate: toolValidator(copy) }
    })
    this.current = { tools: this.tools.map(({ tool: { execute: _handler, ...definition } }) => definition), messages: [], isStreaming: false, pendingToolCalls: [] }
  }

  /** 读取隔离快照，调用方不能修改正在运行的上下文。 */
  get state(): AgentState { return structuredClone(this.current) }
  /** agent_end 订阅完成后才释放占用，供会话和 IPC 判断互斥。 */
  get busy(): boolean { return Boolean(this.active) }

  /** 替换当前会话上下文，只能在空闲时调用；用于切换账号、会话或重试。 */
  replaceMessages(messages: LlmMessage[]): void {
    if (this.busy) throw new Error('请先停止当前生成。')
    this.current.messages = structuredClone(messages)
  }

  /** 订阅同步生命周期事件，返回退订函数；每位订阅者收到独立副本。 */
  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 追加问题并启动循环，立即占用运行状态；模型失败通过终止事件和状态返回。 */
  prompt(config: ModelConfig, message: Extract<LlmMessage, { role: 'user' }>): Promise<void> {
    if (this.busy) throw new Error('请先停止当前生成。')
    const selected = { ...config }
    const { apiKey: _secret, ...model } = selected
    this.current.model = model
    this.current.messages.push(structuredClone(message))
    this.current.isStreaming = true
    this.current.outcome = undefined
    this.current.errorMessage = undefined
    const controller = new AbortController()
    const done = Promise.resolve().then(async () => {
      let outcome: 'complete' | 'stopped' | 'error' = 'complete'
      let error: string | undefined
      try {
        this.publish({ type: 'agent_start' })
        controller.signal.throwIfAborted()
        await this.loop.run(selected, { messages: this.current.messages, tools: this.tools }, controller, event => this.publish(event))
      } catch (cause) {
        error = cause instanceof Error ? cause.message : '生成失败，请重试。'
        outcome = controller.signal.aborted && !error.includes('超时') ? 'stopped' : 'error'
        if (outcome === 'stopped') error = undefined
      } finally {
        try { this.publish({ type: 'agent_end', outcome, error }) }
        finally {
          this.current.isStreaming = false
          this.current.streamingMessage = undefined
          this.current.pendingToolCalls = []
          this.active = undefined
        }
      }
    })
    this.active = { controller, done }
    return done
  }

  /** 取消当前模型或工具；不撤销已发生的工具副作用。 */
  abort(): void { this.active?.controller.abort() }
  /** 等待循环和终止订阅者保存完成，空闲时立即返回。 */
  waitForIdle(): Promise<void> { return this.active?.done || Promise.resolve() }

  /** 先更新内部状态，再通知订阅者；事件副本不能反向污染模型上下文。 */
  private publish(event: AgentEvent): void {
    if (event.type === 'message_start') this.current.streamingMessage = structuredClone(event.message)
    else if (event.type === 'message_update') {
      const content = this.current.streamingMessage!.content
      for (const [type, value] of [['text', event.delta.content], ['thinking', event.delta.reasoning]] as const) {
        if (!value) continue
        const last = content.at(-1)
        if (type === 'text') {
          if (last?.type === 'text') last.text += value
          else content.push({ type, text: value })
        } else {
          if (last?.type === 'thinking') last.thinking += value
          else content.push({ type, thinking: value })
        }
      }
    } else if (event.type === 'message_end') {
      this.current.messages.push(structuredClone(event.message))
      if (event.message.role === 'assistant') this.current.streamingMessage = undefined
    } else if (event.type === 'tool_execution_start') this.current.pendingToolCalls.push(event.toolCallId)
    else if (event.type === 'tool_execution_end') this.current.pendingToolCalls = this.current.pendingToolCalls.filter(id => id !== event.toolCallId)
    else if (event.type === 'agent_end') { this.current.outcome = event.outcome; this.current.errorMessage = event.error }
    let failure: unknown
    for (const listener of [...this.listeners]) {
      try { listener(structuredClone(event)) } catch (error) { failure ??= error }
    }
    if (failure !== undefined) throw failure
  }
}
