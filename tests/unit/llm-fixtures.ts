import type { AgentTool } from '../../src/main/domain/llm'

/** 隔离测试工具，不注册到生产；schema 包含必填、类型和未知字段约束。 */
export const echoTool: AgentTool = {
  name: 'echo', description: '回传文本',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  execute: async input => `结果:${input.text}`
}
export interface TestCall { id: string; name: string; arguments: string }
export const testCall = (id: string, text = '测试'): TestCall => ({ id, name: 'echo', arguments: JSON.stringify({ text }) })

/** 以真实 SSE 帧与 UTF-8 字节碎片验证两个正式适配器，不替换消息转换实现。 */
export function eventBytes(events: object[], done = '', step = 1): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') + done)
  return new ReadableStream({ start(controller) {
    for (let offset = 0; offset < encoded.length; offset += step) controller.enqueue(encoded.slice(offset, offset + step))
    controller.close()
  } })
}

/** OpenAI 参数拆成多次 delta；index 用于关联同轮工具。 */
export function openAIResponse(text = '', calls: TestCall[] = [], reasoning = '', finish = calls.length ? 'tool_calls' : 'stop'): Response {
  return new Response(eventBytes([
    { choices: [{ delta: { content: text, reasoning_content: reasoning, ...(calls.length ? { tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments.slice(0, 3) } })) } : {}) } }] },
    ...(calls.length ? [{ choices: [{ delta: { tool_calls: calls.map((call, index) => ({ index, function: { arguments: call.arguments.slice(3) } })) } }] }] : []),
    { choices: [{ delta: {}, finish_reason: finish }] }
  ], 'data: [DONE]\r\n\r\n'))
}

/** Anthropic 显式开始/结束内容块，工具 JSON 和推理签名都拆成增量。 */
export function anthropicEvents(text = '', calls: TestCall[] = [], reasoning = '', finish = calls.length ? 'tool_use' : 'end_turn'): object[] {
  const events: object[] = [{ type: 'message_start', message: { role: 'assistant', content: [], stop_reason: null } }, { type: 'ping' }]
  let index = 0
  if (reasoning) {
    events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: reasoning } },
      { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'sig-' } },
      { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'signed' } },
      { type: 'content_block_stop', index })
    index++
  }
  if (text) {
    events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }, { type: 'content_block_stop', index })
    index++
  }
  for (const call of calls) {
    events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } },
      { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: call.arguments.slice(0, 3) } },
      { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: call.arguments.slice(3) } }, { type: 'content_block_stop', index })
    index++
  }
  events.push({ type: 'message_delta', delta: { stop_reason: finish } }, { type: 'message_stop' })
  return events
}

export function anthropicResponse(text = '', calls: TestCall[] = [], reasoning = ''): Response { return new Response(eventBytes(anthropicEvents(text, calls, reasoning))) }
