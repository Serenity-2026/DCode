import type { AssistantMessage, LlmContent, LlmDelta, LlmMessage, ToolDefinition } from '../../domain/llm'
import type { ModelConfig } from '../../domain/model-config'
import { consumeEvents, parseEvent, parseToolArguments } from './sse'

/** 将统一消息与工具转换为 OpenAI Chat Completions，按配置发送选项并保留同源工具轮次的推理内容。 */
export function openAIRequest(config: ModelConfig, messages: LlmMessage[], tools: ToolDefinition[], maxTokens: number): object {
  // OpenAI 的 tool 消息不承载图片；先配对这一批所有工具结果，再追加 user 图片消息。
  const converted: object[] = []
  let images: object[] = []
  for (const message of messages) {
    if (message.role === 'toolResult') {
      converted.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.isError ? JSON.stringify({ error: message.content }) : message.content })
      images.push(...(message.images || []).map(image => ({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } })))
      continue
    }
    if (images.length) { converted.push({ role: 'user', content: images }); images = [] }
    if (message.role !== 'assistant') { converted.push(message); continue }
    const toolCalls = message.content.filter(block => block.type === 'toolCall')
    const sameSource = message.source?.api === 'openai-completions' && message.source.baseUrl === config.baseUrl && message.source.model === config.model
    const reasoning = sameSource ? message.content.filter(block => block.type === 'thinking').map(block => block.thinking).join('') : ''
    converted.push({
      role: 'assistant', content: message.content.filter(block => block.type === 'text').map(block => block.text).join(''),
      ...(toolCalls.length ? { tool_calls: toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })), ...(reasoning ? { reasoning_content: reasoning } : {}) } : {})
    })
  }
  if (images.length) converted.push({ role: 'user', content: images })
  return {
    model: config.model, stream: true, max_tokens: maxTokens,
    messages: converted,
    ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: tool })), tool_choice: 'auto' } : {}),
    ...(config.fastMode ? { service_tier: 'priority' } : {}),
    ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {})
  }
}

/** 把 OpenAI SSE 转成统一完整回复；工具参数按 index 拼接，断流或截断不交付调用。 */
export async function consumeSSE(body: ReadableStream<Uint8Array>, onDelta: (delta: LlmDelta) => void, onActivity: () => void = () => {}): Promise<AssistantMessage> {
  const content: LlmContent[] = []
  const calls = new Map<number, { id: string; name: string; arguments: string }>()
  let finish: string | null = null
  const append = (type: 'text' | 'thinking', value: unknown): void => {
    if (value == null) return
    if (typeof value !== 'string') throw new Error('模型文本格式无效。')
    if (!value) return
    const last = content.at(-1)
    if (type === 'text') {
      if (last?.type === 'text') last.text += value
      else content.push({ type, text: value })
      onDelta({ content: value })
    } else {
      if (last?.type === 'thinking') last.thinking += value
      else content.push({ type, thinking: value })
      onDelta({ reasoning: value })
    }
  }
  await consumeEvents(body, data => {
    if (data.trim() === '[DONE]') return true
    const chunk = parseEvent(data)
    if (chunk.error) throw new Error('模型服务返回错误，请重试。')
    if (!Array.isArray(chunk.choices)) throw new Error('模型回复格式无效。')
    const choice = chunk.choices[0]
    const delta = choice?.delta
    if (delta) {
      if (finish) throw new Error('模型结束后仍返回增量。')
      append('thinking', delta.reasoning_content)
      append('text', delta.content)
      if (delta.tool_calls !== undefined) {
        if (!Array.isArray(delta.tool_calls)) throw new Error('模型工具调用格式无效。')
        for (const part of delta.tool_calls) {
          if (!part || !Number.isSafeInteger(part.index) || part.index < 0 || part.index >= 32 || (part.type !== undefined && part.type !== 'function')) throw new Error('模型工具调用格式无效。')
          if ([part.id, part.function?.name, part.function?.arguments].some(value => value !== undefined && typeof value !== 'string')) throw new Error('模型工具调用格式无效。')
          const call = calls.get(part.index) || { id: '', name: '', arguments: '' }
          call.id += part.id || ''; call.name += part.function?.name || ''; call.arguments += part.function?.arguments || ''
          if (call.id.length > 256 || call.name.length > 64 || new TextEncoder().encode(call.arguments).length > 64 * 1024) throw new Error('模型工具参数超过大小上限。')
          calls.set(part.index, call)
        }
      }
    }
    if (choice?.finish_reason) finish = choice.finish_reason
    return false
  }, onActivity)
  if (finish === 'length') throw new Error('回复达到长度上限，内容已保留。')
  if (finish === 'content_filter') throw new Error('回复被服务过滤，内容已保留。')
  if (finish && finish !== 'stop' && finish !== 'tool_calls') throw new Error('模型未返回完整回复，请重试。')
  if ((calls.size > 0) !== (finish === 'tool_calls')) throw new Error('模型工具调用不完整或结束原因无效。')
  const ids = new Set<string>()
  for (const [, call] of [...calls].sort(([a], [b]) => a - b)) {
    if (!call.id.trim() || ids.has(call.id) || !/^[a-zA-Z0-9_-]{1,64}$/.test(call.name)) throw new Error('模型工具调用 ID 或名称无效。')
    ids.add(call.id)
    content.push({ type: 'toolCall', id: call.id, name: call.name, arguments: parseToolArguments(call.arguments) })
  }
  return { role: 'assistant', content, stopReason: finish === 'tool_calls' ? 'toolCall' : 'stop' }
}
