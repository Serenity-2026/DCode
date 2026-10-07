import { waitForTool, type AgentTool, type LlmDelta, type LlmMessage, type ModelStream } from '../domain/llm'
import type { ModelConfig } from '../domain/model-config'
import { toolValidator } from '../infrastructure/tool-schema'

/** 简洁模型/工具循环；依赖模型端口和可信工具列表，不管理存储、窗口或 IPC。 */
export class AgentLoop {
  private readonly tools: { tool: AgentTool; validate: (value: unknown) => boolean }[]

  /** 复制工具定义并预编译参数校验，handler 只在主进程装配时注入。 */
  constructor(private readonly stream: ModelStream, tools: AgentTool[]) {
    if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error('工具名称重复。')
    this.tools = tools.map(tool => {
      const copy = { name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters), execute: tool.execute.bind(tool) }
      return { tool: copy, validate: toolValidator(copy) }
    })
  }

  /** 模型回复 → 顺序执行工具 → 追加结果 → 再请求；无工具调用时结束，取消立即退出。 */
  async run(config: ModelConfig, context: LlmMessage[], controller: AbortController, onDelta: (delta: LlmDelta) => void): Promise<void> {
    const messages = structuredClone(context)
    const definitions = this.tools.map(({ tool: { execute: _handler, ...definition } }) => definition)
    const ids = new Set<string>()
    for (let turn = 0; turn < 8; turn++) {
      controller.signal.throwIfAborted()
      const reply = await this.stream(config, messages, controller, delta => { if (!controller.signal.aborted) onDelta(delta) }, definitions)
      controller.signal.throwIfAborted()
      messages.push(reply)
      const calls = reply.content.filter(block => block.type === 'toolCall')
      if (!calls.length) {
        if (reply.stopReason !== 'stop' || !reply.content.some(block => block.type === 'text' && block.text.trim())) throw new Error('模型没有返回文本，请重试。')
        return
      }
      if (reply.stopReason !== 'toolCall') throw new Error('模型工具调用结束原因无效。')
      if (turn === 7) throw new Error('Agent 已达到循环上限。')
      for (const call of calls) {
        controller.signal.throwIfAborted()
        if (ids.has(call.id)) throw new Error('模型工具调用 ID 重复。')
        ids.add(call.id)
        const registered = this.tools.find(item => item.tool.name === call.name)
        let content = '工具未注册。'
        let isError = true
        if (registered) {
          if (!registered.validate(call.arguments)) content = '工具参数不符合 JSON Schema。'
          else try {
            content = await waitForTool(() => registered.tool.execute(call.arguments, controller.signal), controller.signal)
            if (typeof content !== 'string') throw new Error('工具结果无效。')
            isError = false
          } catch { controller.signal.throwIfAborted(); content = '工具执行失败。' }
        }
        messages.push({ role: 'toolResult', toolCallId: call.id, content, isError })
      }
    }
  }
}
