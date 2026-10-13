import type { AssistantMessage, LlmContent, LlmDelta, LlmMessage, ToolDefinition } from '../../domain/llm'
import type { ModelConfig } from '../../domain/model-config'
import { consumeEvents, parseEvent, parseToolArguments } from './sse'

/** 转换统一上下文，system 独立发送，同轮 toolResult 合并到紧随 assistant 的 user 消息。 */
export function anthropicRequest(config: ModelConfig, context: LlmMessage[], tools: ToolDefinition[], maxTokens: number): object {
  const messages: { role: 'user' | 'assistant'; content: object[] }[] = []
  for (const message of context) {
    if (message.role === 'system') continue
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const content: object[] = message.role === 'toolResult' ? [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.images?.length ? [{ type: 'text', text: message.content }, ...message.images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } }))] : message.content, is_error: message.isError }]
      : message.role === 'user' ? [{ type: 'text', text: message.content }]
        : message.content.flatMap((block): object[] => {
          if (block.type === 'text') return [{ type: 'text', text: block.text }]
          if (block.type === 'toolCall') return [{ type: 'tool_use', id: block.id, name: block.name, input: block.arguments }]
          const sameSource = message.source?.api === 'anthropic-messages' && message.source.baseUrl === config.baseUrl && message.source.model === config.model
          return sameSource && block.signature ? [block.redacted ? { type: 'redacted_thinking', data: block.signature } : { type: 'thinking', thinking: block.thinking, signature: block.signature }] : []
        })
    if (!content.length) continue
    const previous = messages.at(-1)
    if (previous?.role === role) previous.content.push(...content)
    else messages.push({ role, content })
  }
  return {
    model: config.model, stream: true, max_tokens: maxTokens, messages,
    system: context.filter(message => message.role === 'system').map(message => message.content).join('\n'),
    ...(tools.length ? { tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })), tool_choice: { type: 'auto' } } : {})
  }
}

/** 解析原生 Anthropic 内容块与参数碎片，保留签名；message_stop 之前不交付可执行回复。 */
export async function consumeAnthropic(body: ReadableStream<Uint8Array>, onDelta: (delta: LlmDelta) => void, onActivity: () => void = () => {}): Promise<AssistantMessage> {
  const blocks = new Map<number, { content: LlmContent; json: string | null; closed: boolean }>()
  const ids = new Set<string>()
  let started = false
  let finish: string | null = null
  await consumeEvents(body, data => {
    const event = parseEvent(data)
    if (event.type === 'ping') return false
    if (event.type === 'error') throw new Error('模型服务返回错误，请重试。')
    if (event.type === 'message_start') {
      if (started || event.message?.role !== 'assistant') throw new Error('模型回复格式无效。')
      started = true
    } else if (!started) throw new Error('模型回复缺少开始标记。')
    else if (event.type === 'content_block_start') {
      if (finish || !Number.isSafeInteger(event.index) || event.index < 0 || event.index >= 32 || blocks.has(event.index)) throw new Error('模型内容块无效。')
      const block = event.content_block
      let content: LlmContent
      if (block?.type === 'text' && typeof block.text === 'string') { content = { type: 'text', text: block.text }; if (block.text) onDelta({ content: block.text }) }
      else if (block?.type === 'thinking' && typeof block.thinking === 'string') { content = { type: 'thinking', thinking: block.thinking, signature: block.signature || '' }; if (block.thinking) onDelta({ reasoning: block.thinking }) }
      else if (block?.type === 'redacted_thinking' && typeof block.data === 'string') content = { type: 'thinking', thinking: '', signature: block.data, redacted: true }
      else if (block?.type === 'tool_use' && typeof block.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(block.id) && typeof block.name === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(block.name) && !ids.has(block.id)) {
        ids.add(block.id)
        content = { type: 'toolCall', id: block.id, name: block.name, arguments: parseToolArguments(JSON.stringify(block.input)) }
      } else throw new Error('模型内容块或工具调用格式无效。')
      blocks.set(event.index, { content, json: null, closed: false })
    } else if (event.type === 'content_block_delta') {
      const entry = blocks.get(event.index)
      const delta = event.delta
      if (!entry || entry.closed || finish) throw new Error('模型内容块增量无效。')
      if (delta?.type === 'text_delta' && entry.content.type === 'text' && typeof delta.text === 'string') { entry.content.text += delta.text; onDelta({ content: delta.text }) }
      else if (delta?.type === 'thinking_delta' && entry.content.type === 'thinking' && !entry.content.redacted && typeof delta.thinking === 'string') { entry.content.thinking += delta.thinking; onDelta({ reasoning: delta.thinking }) }
      else if (delta?.type === 'signature_delta' && entry.content.type === 'thinking' && typeof delta.signature === 'string') entry.content.signature = (entry.content.signature || '') + delta.signature
      else if (delta?.type === 'input_json_delta' && entry.content.type === 'toolCall' && typeof delta.partial_json === 'string') {
        entry.json = (entry.json || '') + delta.partial_json
        if (new TextEncoder().encode(entry.json).length > 64 * 1024) throw new Error('模型工具参数超过大小上限。')
      } else throw new Error('模型内容块增量格式无效。')
    } else if (event.type === 'content_block_stop') {
      const entry = blocks.get(event.index)
      if (!entry || entry.closed) throw new Error('模型内容块结束标记无效。')
      if (entry.content.type === 'toolCall' && entry.json !== null) entry.content.arguments = parseToolArguments(entry.json)
      entry.closed = true
    } else if (event.type === 'message_delta') {
      if ([...blocks.values()].some(block => !block.closed)) throw new Error('模型内容块尚未结束。')
      if (event.delta?.stop_reason) finish = event.delta.stop_reason
    } else if (event.type === 'message_stop') {
      if (!finish || [...blocks.values()].some(block => !block.closed)) throw new Error('模型回复尚未完成。')
      return true
    } else throw new Error('模型返回不支持的流事件。')
    return false
  }, onActivity)
  if (finish === 'max_tokens') throw new Error('回复达到长度上限，内容已保留。')
  if (!['end_turn', 'stop_sequence', 'tool_use'].includes(finish || '')) throw new Error('模型未返回完整回复，请重试。')
  if ((ids.size > 0) !== (finish === 'tool_use')) throw new Error('模型工具调用不完整或结束原因无效。')
  return { role: 'assistant', content: [...blocks].sort(([a], [b]) => a - b).map(([, entry]) => entry.content), stopReason: finish === 'tool_use' ? 'toolCall' : 'stop' }
}
