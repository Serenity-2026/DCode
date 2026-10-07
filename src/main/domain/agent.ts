import type { AgentTool, AssistantMessage, LlmDelta, LlmMessage, ToolDefinition } from './llm'
import type { ModelConfig } from './model-config'

/** 启动时编译的可信工具，循环仅使用 handler 与参数校验函数。 */
export interface RegisteredTool { tool: AgentTool; validate: (value: unknown) => boolean }
/** 单次循环上下文，Agent 保有正式消息，循环操作独立副本。 */
export interface AgentContext { messages: LlmMessage[]; tools: RegisteredTool[] }
export type ToolResultMessage = Extract<LlmMessage, { role: 'toolResult' }>
/** 本次运行结果，与应用会话的磁盘消息状态分开。 */
export type AgentOutcome = 'complete' | 'stopped' | 'error'

/** 独立运行时状态；公开模型信息不含密钥，工具只包含声明。 */
export interface AgentState {
  model?: Omit<ModelConfig, 'apiKey'>
  tools: ToolDefinition[]
  messages: LlmMessage[]
  isStreaming: boolean
  streamingMessage?: AssistantMessage
  pendingToolCalls: string[]
  outcome?: AgentOutcome
  errorMessage?: string
}

/** 底层循环事件，供 Agent 更新状态、会话层保存和推送，不包含应用 DTO。 */
export type AgentLoopEvent =
  | { type: 'turn_start' }
  | { type: 'message_start'; message: AssistantMessage }
  | { type: 'message_update'; delta: LlmDelta }
  | { type: 'message_end'; message: AssistantMessage | ToolResultMessage }
  | { type: 'tool_execution_start'; toolCallId: string; name: string }
  | { type: 'tool_execution_end'; toolCallId: string; name: string; result: ToolResultMessage }
  | { type: 'turn_end'; message: AssistantMessage; toolResults: ToolResultMessage[] }

/** Agent 对外生命周期；同步订阅完成后才结束运行。 */
export type AgentEvent = AgentLoopEvent
  | { type: 'agent_start' }
  | { type: 'agent_end'; outcome: AgentOutcome; error?: string }
