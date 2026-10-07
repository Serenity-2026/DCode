import { waitForTool, type ModelStream } from '../domain/llm'
import type { AgentContext, AgentLoopEvent, ToolResultMessage } from '../domain/agent'
import type { ModelConfig } from '../domain/model-config'

/** 底层模型/工具循环；仅使用单次上下文与事件出口，不拥有会话或运行状态。 */
export class AgentLoop {
  /** 模型端口由 app 注入，循环不选择供应商或读取秘密。 */
  constructor(private readonly stream: ModelStream) {}

  /** 模型回复 → 顺序执行工具 → 追加结果 → 再请求；无工具调用时结束，取消立即退出。
   * 给定消息上下文和工具，持续请求模型；模型要求调用工具就执行，再把结果交回模型；模型给出最终回答就结束。
   * 返回值是 Promise<void>。最终文本不会作为 run() 的返回值交出来，而是通过事件交给上层。
   * 正常结束时 Promise 完成；模型请求异常、取消、循环超限等情况则抛出异常，由 Agent 处理。
   * */
  async run(config: ModelConfig, context: AgentContext, controller: AbortController, emit: (event: AgentLoopEvent) => void): Promise<void> {
    //初始消息的深拷贝
    const messages = structuredClone(context.messages)
    // 写法等同于：
    // const definitions = context.tools.map(item => {
    //   const tool = item.tool
    //
    //   const {
    //     execute: _handler,
    //     ...definition
    //   } = tool
    //
    //   return definition
    // })
    const definitions = context.tools.map(({ tool: { execute: _handler, ...definition } }) => definition)
    const ids = new Set<string>()
    for (let turn = 0; turn < 8; turn++) {
      controller.signal.throwIfAborted()
      emit({ type: 'turn_start' })
      //本轮模型回复即将开始，请建立一个空的 assistant 草稿，准备接收后面的文本增量。
      emit({ type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'stop' } })
      //收到增量，完毕后返回AssistantMessage
      const reply = await this.stream(config, messages, controller, delta => { if (!controller.signal.aborted) emit({ type: 'message_update', delta }) }, definitions)
      controller.signal.throwIfAborted()
      messages.push(reply)
      emit({ type: 'message_end', message: reply })
      const calls = reply.content.filter(block => block.type === 'toolCall')
      const toolResults: ToolResultMessage[] = []
      //如果模型没有要求执行工具，就检查它是否给出了正常的最终文本；有效则结束本轮和整个循环，否则报错。
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
            //waitForTool:工具正常完成，就返回工具结果；用户提前取消，就让等待工具的代码立即收到异常。
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
