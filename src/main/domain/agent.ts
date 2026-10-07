import type { ToolCall } from '../../shared/types'
import type { ModelConfig } from './model-config'

/** 框架固定的安全边界，模型适配、执行器与磁盘格式校验共用。 */
export const agentLimits = {
  maxRounds: 8, maxCallsPerRound: 8, maxToolCalls: 32,
  maxArgumentBytes: 64 * 1024, maxResultBytes: 128 * 1024,
  toolTimeoutMs: 30_000, runTimeoutMs: 300_000
} as const

/** 主进程可信代码注册的函数定义，参数使用 JSON Schema draft-07。 */
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown> }

/** 工具 handler 只得到校验后的参数和取消信号，不获取模型配置与密钥。 */
export interface AgentTool {
  definition: ToolDefinition
  execute(parameters: Record<string, unknown>, context: { signal: AbortSignal }): Promise<string>
}

/** 环境独立的模型上下文；网络适配器负责转换服务使用的字段名。 */
export type ModelMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; reasoning?: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string }

/** 文本增量与完整模型轮次，工具仅在完整轮次返回后交给循环执行。 */
export interface ModelDelta { content?: string; reasoning?: string }
export interface ModelTurn { content: string; reasoning: string; toolCalls: ToolCall[]; finishReason: 'stop' | 'tool_calls' }

/** AgentLoop 依赖的模型端口，不依赖 HTTP/SSE 或 Electron。 */
export interface ModelGateway {
  stream(config: ModelConfig, messages: ModelMessage[], signal: AbortSignal, onDelta: (delta: ModelDelta) => void, tools: ToolDefinition[]): Promise<ModelTurn>
}

/** 等待可取消的外部操作；停止后移除监听，不再等待不合作的 handler。 */
export function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation() }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
