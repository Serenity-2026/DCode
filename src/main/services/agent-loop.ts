import { waitForTool, type ModelStream } from '../domain/llm'
import type { AgentContext, AgentLoopEvent, ToolResultMessage } from '../domain/agent'
import type { ModelConfig } from '../domain/model-config'

/** 底层模型/工具循环；仅使用单次上下文与事件出口，不拥有会话或运行状态。 */
export class AgentLoop {
  /** 模型端口由 app 注入，循环不选择供应商或读取秘密。 */
  constructor(private readonly stream: ModelStream) {}

  /** 模型回复 → 顺序执行工具 → 追加结果 → 再请求；无工具调用时结束，取消立即退出。 */
  async run(config: ModelConfig, context: AgentContext, controller: AbortController, emit: (event: AgentLoopEvent) => void): Promise<void> {
    const messages = structuredClone(context.messages)
    const definitions = context.tools.map(({ tool: { execute: _handler, ...definition } }) => definition)
    const ids = new Set<string>()
    for (let turn = 0; turn < 8; turn++) {
      controller.signal.throwIfAborted()
      emit({ type: 'turn_start' })
      emit({ type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'stop' } })
      const reply = await this.stream(config, messages, controller, delta => { if (!controller.signal.aborted) emit({ type: 'message_update', delta }) }, definitions)
      controller.signal.throwIfAborted()
      messages.push(reply)
      emit({ type: 'message_end', message: reply })
      const calls = reply.content.filter(block => block.type === 'toolCall')
      const toolResults: ToolResultMessage[] = []
      if (!calls.length) {
        if (reply.stopReason !== 'stop' || !reply.content.some(block => block.type === 'text' && block.text.trim())) throw new Error('模型没有返回文本，请重试。')
        emit({ type: 'turn_end', message: reply, toolResults })
        return
      }
      if (reply.stopReason !== 'toolCall') throw new Error('模型工具调用结束原因无效。')
      if (turn === 7) throw new Error('Agent 已达到循环上限。')
      for (const call of calls) {
        controller.signal.throwIfAborted()
        if (ids.has(call.id)) throw new Error('模型工具调用 ID 重复。')
        ids.add(call.id)
        emit({ type: 'tool_execution_start', toolCallId: call.id, name: call.name })
        const registered = context.tools.find(item => item.tool.name === call.name)
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
        const result: ToolResultMessage = { role: 'toolResult', toolCallId: call.id, content, isError }
        messages.push(result)
        toolResults.push(result)
        emit({ type: 'tool_execution_end', toolCallId: call.id, name: call.name, result })
        emit({ type: 'message_end', message: result })
      }
      emit({ type: 'turn_end', message: reply, toolResults })
    }
  }
}
