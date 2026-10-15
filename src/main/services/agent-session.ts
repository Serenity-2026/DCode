import type { SendInput, Snapshot, StreamEvent } from '../../shared/types'
import { contextMessages, conversationDirectory, isFilePreview } from '../../shared/context'
import type { AgentEvent } from '../domain/agent'
import { toLlmMessages, type LlmMessage, type ToolWorkspace } from '../domain/llm'
import type { ModelConfig } from '../domain/model-config'
import { Agent } from './agent'
import { StateService } from './state-service'

/** 应用会话层：准备上下文、保存正文和推送界面；运行控制由独立 Agent 负责。 */
export class AgentSession {
  // 用 ID 定位当前仓库对象，其他会话的事务回滚不会使流式更新写到旧引用。
  private target?: { conversationId: string; messageId: string; lastSave: number; lastEmit: number }

  /** 订阅 Agent 事件并注入应用报告回调；本层只恢复会话状态，不持有取消控制器。 */
  constructor(private store: StateService, private emit: (event: StreamEvent) => void, private readonly agent: Agent, private readonly reportError: (error: unknown) => void, private readonly workspace?: ToolWorkspace) {
    //Agent 有事件时，调用该函数；这个函数再把事件交给 onEvent() 处理。
    this.agent.subscribe(event => this.onEvent(event))
  }

  /** 等待终止事件完成保存之前，IPC 与窗口都继续视为忙碌。 */
  get busy(): boolean { return this.agent.busy }

  /** 创建回复占位，替换为当前会话成功历史，再把本次问题交给 Agent。 */
  send(input: SendInput, config: ModelConfig): Snapshot {
    this.store.requireUser()
    if (this.busy) throw new Error('请先停止当前生成。')
    if (!input || typeof input !== 'object' || (input.retry !== undefined && typeof input.retry !== 'boolean')) throw new Error('无效请求。')
    if (!config.apiKey) throw new Error('请先配置模型 API 密钥。')
    const { conversation, message } = this.store.begin(input.content, Boolean(input.retry), config.model, input.attachments, input.conversationId)
    const target = this.target = { conversationId: conversation.id, messageId: message.id, lastSave: Date.now(), lastEmit: 0 }
    try {
      this.workspace?.setDirectory(conversationDirectory(conversation))
      const context = toLlmMessages(contextMessages(conversation))
      const prompt = context.pop() as Extract<LlmMessage, { role: 'user' }>
      this.agent.replaceMessages(context)
      // 常规运行错误由 agent_end 保存；启动或收尾异常也必须投影到固定回复。
      void this.agent.prompt(config, prompt)
        .catch(error => this.finishFailure(target, error))
        .catch(error => this.reportError(error))
    } catch (error) {
      this.finishFailure(target, error)
      throw error
    }
    return this.store.snapshot()
  }

  /** 取消并等待 Agent 终止事件保存完成，再向界面返回最终快照。 */
  async stop(): Promise<Snapshot> {
    this.agent.abort()
    await this.agent.waitForIdle()
    this.store.save()
    return this.store.snapshot()
  }

  /** 将失败投影为固定回复并尝试保存/推送；恢复仍失败时抛出汇总错误，由调用边界报告。 */
  private finishFailure(target: { conversationId: string; messageId: string }, cause: unknown): void {
    const errors = [cause instanceof Error ? cause.message : '任务收尾失败。']
    const conversation = this.store.state.conversations.find(item => item.id === target.conversationId)
    const message = conversation?.messages.find(item => item.id === target.messageId)
    let report = false
    if (conversation && message) {
      message.status = 'error'
      message.error = errors[0]
      for (const tool of message.toolExecutions || []) if (tool.status === 'running') tool.status = 'error'
      conversation.updatedAt = new Date().toISOString()
      try { this.store.save() } catch (error) {
        errors.push(`保存失败：${error instanceof Error ? error.message : '无法保存回复。'}`)
        message.error = errors.join('\n')
        report = true
      }
      try { this.emit({ conversationId: conversation.id, message: structuredClone(message) }) } catch (error) {
        errors.push(`界面通知失败：${error instanceof Error ? error.message : '无法推送回复。'}`)
        message.error = errors.join('\n')
        report = true
      }
    } else { errors.push('无法定位任务回复。'); report = true }
    if (this.target?.messageId === target.messageId) this.target = undefined
    if (report) throw new Error(errors.join('\n'), { cause })
  }

  /** 将运行时事件投影为现有会话格式；完整工具上下文由 Agent 保留。 */
  private onEvent(event: AgentEvent): void {
    const target = this.target
    if (!target) return
    const conversation = this.store.state.conversations.find(item => item.id === target.conversationId)!
    const message = conversation.messages.find(item => item.id === target.messageId)!
    if (event.type === 'message_update') {
      message.content += event.delta.content || ''
      message.reasoning += event.delta.reasoning || ''
      if (Date.now() - target.lastSave >= 500) { this.store.save(); target.lastSave = Date.now() }
      if (Date.now() - target.lastEmit >= 30) {
        this.emit({ conversationId: conversation.id, message: structuredClone(message) })
        target.lastEmit = Date.now()
      }
    } else if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      if (event.type === 'tool_execution_start') {
        const path = ['read', 'write', 'edit'].includes(event.name) && typeof event.arguments.path === 'string' && event.arguments.path.trim() && !event.arguments.path.includes('\0') ? event.arguments.path : undefined
        const command = event.name === 'bash' && typeof event.arguments.command === 'string' ? event.arguments.command : undefined
        const tools = message.toolExecutions ||= []
        tools.push({ id: event.toolCallId, name: event.name, status: 'running', offset: message.content.length, ...(path ? { path } : {}), ...(command !== undefined ? { command } : {}) })
      } else {
        const tool = message.toolExecutions?.find(tool => tool.id === event.toolCallId)
        if (tool) {
          tool.status = event.result.isError ? 'error' : 'complete'
          const details = event.result.details as { preview?: unknown } | undefined
          if (tool.path && !event.result.isError && isFilePreview(details?.preview)) tool.preview = structuredClone(details.preview)
        }
      }
      // 保留已结束的调用，快速工具也可见；状态立即推送，不受正文节流影响。
      this.emit({ conversationId: conversation.id, message: structuredClone(message) })
    } else if (event.type === 'agent_end') {
      message.status = event.outcome
      for (const tool of message.toolExecutions || []) if (tool.status === 'running') tool.status = event.outcome === 'stopped' ? 'stopped' : 'error'
      if (event.error) message.error = event.error
      conversation.updatedAt = new Date().toISOString()
      this.store.save()
      this.target = undefined
      this.emit({ conversationId: conversation.id, message: structuredClone(message) })
    }
  }
}
