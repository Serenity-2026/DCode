import type { AgentLoopEvent, RegisteredTool, ToolResultMessage } from '../domain/agent'
import { ToolExecutionError, waitForTool, type AgentToolResult, type LlmContent } from '../domain/llm'

type ToolCall = Extract<LlmContent, { type: 'toolCall' }>
type ToolExecutionEvent = Extract<AgentLoopEvent, { type: 'tool_execution_start' | 'tool_execution_end' }>
interface Invocation { call: ToolCall; registered?: RegisteredTool }

/** 无状态工具执行层；只依据注册契约分组，不识别具体工具或应用会话。 */
export class ToolExecutor {
  /** 连续并行调用合组，串行调用形成屏障；整批结果保持模型调用顺序。 */
  async execute(calls: ToolCall[], tools: RegisteredTool[], signal: AbortSignal, emit: (event: ToolExecutionEvent) => void): Promise<ToolResultMessage[]> {
    signal.throwIfAborted()
    if (new Set(calls.map(call => call.id)).size !== calls.length) throw new Error('模型工具调用 ID 重复。')
    const results: ToolResultMessage[] = []
    for (const group of this.groups(calls, tools)) {
      signal.throwIfAborted()
      // 等同组全部结算，框架异常也不能让已启动调用在任务结束后继续推送事件。
      const settled = await Promise.allSettled(group.map(invocation => this.executeOne(invocation, signal, emit)))
      for (const outcome of settled) if (outcome.status === 'fulfilled') results.push(outcome.value)
      signal.throwIfAborted()
      const failed = settled.find(outcome => outcome.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    }
    return results
  }

  /** 按源顺序划分分组；未注册或未声明模式的调用各自串行，不跨屏障合并。 */
  private groups(calls: ToolCall[], tools: RegisteredTool[]): Invocation[][] {
    const groups: Invocation[][] = []
    let parallel: Invocation[] = []
    for (const call of calls) {
      const registered = tools.find(item => item.tool.name === call.name)
      const invocation = { call, registered }
      if (registered?.tool.executionMode === 'parallel') parallel.push(invocation)
      else {
        if (parallel.length) { groups.push(parallel); parallel = [] }
        groups.push([invocation])
      }
    }
    if (parallel.length) groups.push(parallel)
    return groups
  }

  /** 校验、执行和结果处理异常均转换为工具结果；取消与事件订阅异常向上传播。 */
  private async executeOne({ call, registered }: Invocation, signal: AbortSignal, emit: (event: ToolExecutionEvent) => void): Promise<ToolResultMessage> {
    signal.throwIfAborted()
    emit({ type: 'tool_execution_start', toolCallId: call.id, name: call.name })
    let output: AgentToolResult = { content: [{ type: 'text', text: '工具未注册。' }], details: undefined, isError: true }
    try {
      if (registered) {
        if (!registered.validate(call.arguments)) output.content = [{ type: 'text', text: '工具参数不符合 JSON Schema。' }]
        else {
          const returned = await waitForTool(() => registered.tool.execute(call.arguments, signal), signal)
          signal.throwIfAborted()
          if (!returned || !Array.isArray(returned.content) || returned.content.some(block => !block || (block.type === 'text'
            ? typeof block.text !== 'string'
            : block.type !== 'image' || typeof block.data !== 'string' || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(block.mimeType)))) throw new Error('工具结果无效。')
          output = structuredClone(returned)
        }
      }
    } catch (error) {
      signal.throwIfAborted()
      const reason = error instanceof Error ? error.message : String(error)
      output = { content: [{ type: 'text', text: error instanceof ToolExecutionError ? reason : `工具调用异常：${reason}` }], details: undefined, isError: true }
    }
    signal.throwIfAborted()
    const result: ToolResultMessage = { ...output, role: 'toolResult', toolCallId: call.id, isError: output.isError === true }
    emit({ type: 'tool_execution_end', toolCallId: call.id, name: call.name, result: structuredClone(result) })
    return result
  }
}
