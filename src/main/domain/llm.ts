import type { ModelApi } from '../../shared/types'
import type { ModelConfig } from './model-config'

/** 统一内容块；供应商的 tool_calls/tool_use 字段不进入业务循环。 */
export type LlmContent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string; redacted?: boolean }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }

/** 完整模型回复；来源用于限制原生推理签名只能回传原服务与模型。 */
export interface AssistantMessage {
  role: 'assistant'
  content: LlmContent[]
  stopReason: 'stop' | 'toolCall'
  source?: { api: ModelApi; baseUrl: string; model: string }
}

/** 工具读取的图片由适配器转换到供应商格式，不向应用磁盘保存 base64。 */
export interface ToolImage { type: 'image'; data: string; mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' }
/** 保留字符串返回兼容，文件读取可同时提供文字与图片。 */
export interface ToolOutput { content: string; images?: ToolImage[] }

/** 循环统一上下文，包括工具结果；应用历史在模型边界前转换为此类型。 */
export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | AssistantMessage
  | ({ role: 'toolResult'; toolCallId: string; isError: boolean } & ToolOutput)

/** 工具定义与主进程 handler，参数 JSON Schema 在启动装配时编译。 */
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown> }
export interface AgentTool extends ToolDefinition { execute(argumentsValue: Record<string, unknown>, signal: AbortSignal): Promise<string | ToolOutput> }

/** 可向模型展示的预期工具错误；其他异常仍由循环隐藏细节。 */
export class ToolExecutionError extends Error {}

/** 会话只配置本轮目录，系统工具实现磁盘与进程访问。 */
export interface ToolWorkspace { setDirectory(directory?: string): void }

/** AgentSession 只消费文本增量，完整内容块由模型端口返回给循环。 */
export interface LlmDelta { content?: string; reasoning?: string }
export type ModelStream = (config: ModelConfig, messages: LlmMessage[], controller: AbortController, onDelta: (delta: LlmDelta) => void, tools: ToolDefinition[]) => Promise<AssistantMessage>

/** 将现有成功问答上下文转为统一消息；不带历史推理或工具执行记录。 */
export function toLlmMessages(messages: { role: 'system' | 'user' | 'assistant'; content: string }[]): LlmMessage[] {
  return messages.map(message => message.role === 'assistant' ? { role: 'assistant', content: [{ type: 'text', text: message.content }], stopReason: 'stop' } : { role: message.role, content: message.content })
}

/** 停止等待不配合取消的异步工具，避免阻塞现有 AgentSession.stop；不能撤销已发生的副作用。 */
export function waitForTool<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  //resolve(结果)：告诉 Promise“成功了，这是结果”；reject(原因)：告诉 Promise“失败了，这是原因”。
  return new Promise((resolve, reject) => {

    const abort = (): void => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation() }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
