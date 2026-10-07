import { afterEach, expect, it, vi } from 'vitest'
import { streamModel, listModels } from '../../src/main/infrastructure/model-client'
import { consumeAnthropic, anthropicRequest } from '../../src/main/infrastructure/llm/anthropic'
import { consumeSSE, openAIRequest } from '../../src/main/infrastructure/llm/openai'
import { resolveModelApi } from '../../src/shared/model-api'
import type { AssistantMessage, LlmMessage } from '../../src/main/domain/llm'
import type { ModelApi } from '../../src/shared/types'
import { config } from './helpers'
import { anthropicEvents, anthropicResponse, echoTool, eventBytes, openAIResponse, testCall } from './llm-fixtures'

afterEach(() => vi.unstubAllGlobals())

it.each<ModelApi>(['openai-completions', 'anthropic-messages'])('normalizes text, thinking and split tool arguments from %s', async api => {
  const reply = api === 'anthropic-messages' ? anthropicResponse('正文🙂', [testCall('a', '你好'), testCall('b', '二')], '思考') : openAIResponse('正文🙂', [testCall('a', '你好'), testCall('b', '二')], '思考')
  const fetchMock = vi.fn().mockResolvedValue(reply)
  vi.stubGlobal('fetch', fetchMock)
  const deltas: { content?: string; reasoning?: string }[] = []
  const result = await streamModel({ ...config, api }, [{ role: 'user', content: '测试' }], new AbortController(), delta => deltas.push(delta), { tools: [echoTool] })
  expect(result).toMatchObject({ role: 'assistant', stopReason: 'toolCall', source: { api, model: 'test' } })
  expect(result.content.filter(block => block.type === 'toolCall')).toEqual([testCall('a', '你好'), testCall('b', '二')].map(call => ({ type: 'toolCall', id: call.id, name: call.name, arguments: JSON.parse(call.arguments) })))
  expect(deltas.map(delta => delta.content || '').join('')).toBe('正文🙂')
  expect(deltas.map(delta => delta.reasoning || '').join('')).toBe('思考')
  const [url, options] = fetchMock.mock.calls[0]
  expect(url).toBe(api === 'anthropic-messages' ? `${config.baseUrl}/v1/messages` : `${config.baseUrl}/chat/completions`)
  expect(options.headers).toMatchObject(api === 'anthropic-messages' ? { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${config.apiKey}` })
  expect(options.body).not.toContain(config.apiKey)
})

it('sends Anthropic system, grouped tool results, signed thinking and native schema without OpenAI fields', () => {
  const selected = { ...config, api: 'anthropic-messages' as const, fastMode: true, reasoningEffort: 'high' as const }
  const message: AssistantMessage = { role: 'assistant', stopReason: 'toolCall', source: { api: selected.api, baseUrl: selected.baseUrl, model: selected.model }, content: [
    { type: 'thinking', thinking: '计划', signature: 'sig-signed' }, { type: 'thinking', thinking: '', redacted: true, signature: 'opaque-data' },
    { type: 'toolCall', id: 'a', name: 'echo', arguments: { text: '一' } }, { type: 'toolCall', id: 'b', name: 'echo', arguments: { text: '二' } }
  ] }
  const context: LlmMessage[] = [{ role: 'system', content: '系统提示' }, { role: 'user', content: '问题' }, message,
    { role: 'toolResult', toolCallId: 'a', content: '一', isError: false }, { role: 'toolResult', toolCallId: 'b', content: '失败', isError: true }]
  const request = anthropicRequest(selected, context, [echoTool], 1000) as { system: string; messages: { role: string; content: object[] }[]; tools: object[] }
  expect(request.system).toBe('系统提示')
  expect(request.messages).toHaveLength(3)
  expect(request.messages[1].content.slice(0, 2)).toEqual([{ type: 'thinking', thinking: '计划', signature: 'sig-signed' }, { type: 'redacted_thinking', data: 'opaque-data' }])
  expect(request.messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '一', is_error: false }, { type: 'tool_result', tool_use_id: 'b', content: '失败', is_error: true }] })
  expect(request.tools).toEqual([{ name: echoTool.name, description: echoTool.description, input_schema: echoTool.parameters }])
  expect(request).not.toHaveProperty('reasoning_effort')
  expect(request).not.toHaveProperty('service_tier')
})

it.each([{ api: 'openai-completions' as const }, { model: 'different' }, { baseUrl: 'https://different.example.com' }])('does not replay signed thinking to a different source: %j', change => {
  const selected = { ...config, api: 'anthropic-messages' as const }
  const message: AssistantMessage = { role: 'assistant', stopReason: 'stop', source: { api: selected.api, baseUrl: selected.baseUrl, model: selected.model }, content: [{ type: 'text', text: '正文' }, { type: 'thinking', thinking: '思考', signature: 'secret-signature' }, { type: 'thinking', thinking: '', signature: 'opaque-data', redacted: true }] }
  const target = { ...selected, ...change }
  const convert = target.api === 'anthropic-messages' ? anthropicRequest : openAIRequest
  const request = convert(target, [message], [], 1000)
  expect(JSON.stringify(request)).not.toContain('secret-signature')
  expect(JSON.stringify(request)).not.toContain('opaque-data')
  expect(JSON.stringify(openAIRequest(config, [message], [], 1000))).not.toContain('思考')
})

it('uses explicit transport even for a Claude model served by an OpenAI gateway', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(openAIResponse('OK')))
  await streamModel({ ...config, api: 'openai-completions', model: 'claude-through-gateway' }, [], new AbortController(), () => {})
  expect(vi.mocked(fetch).mock.calls[0][0]).toBe(`${config.baseUrl}/chat/completions`)
  expect(resolveModelApi('https://api.anthropic.com')).toBe('anthropic-messages')
  expect(resolveModelApi('https://gateway.example.com/v1')).toBe('openai-completions')
  expect(resolveModelApi('https://api.anthropic.com', 'openai-completions')).toBe('openai-completions')
  expect(() => resolveModelApi(config.baseUrl, 'unsupported' as ModelApi)).toThrow('协议无效')
})

it('rejects incomplete, truncated and malformed Anthropic tools', async () => {
  const events = anthropicEvents('', [testCall('a')])
  await expect(consumeAnthropic(eventBytes(events.slice(0, -1)), () => {})).rejects.toThrow('连接中断')
  await expect(consumeAnthropic(eventBytes(anthropicEvents('', [testCall('a')], '', 'max_tokens')), () => {})).rejects.toThrow('长度上限')
  await expect(consumeAnthropic(eventBytes(anthropicEvents('', [{ ...testCall('a'), arguments: '{broken' }])), () => {})).rejects.toThrow('完整 JSON')
  await expect(consumeAnthropic(eventBytes(anthropicEvents('', [testCall('a'), testCall('a')])), () => {})).rejects.toThrow('工具调用')
  await expect(consumeAnthropic(eventBytes(events.filter(event => (event as { type: string }).type !== 'content_block_stop')), () => {})).rejects.toThrow('尚未结束')
})

it('rejects malformed OpenAI JSON and tool calls with mismatched finish reasons', async () => {
  for (const response of [openAIResponse('', [{ ...testCall('a'), arguments: '{broken' }]), openAIResponse('', [testCall('a')], '', 'stop'), openAIResponse('', [testCall('a'), testCall('a')])]) {
    await expect(consumeSSE(response.body!, () => {})).rejects.toThrow('工具')
  }
  await expect(consumeSSE(openAIResponse('', [testCall('a')], '', 'length').body!, () => {})).rejects.toThrow('长度上限')
})

it('discovers all native Anthropic model pages using native authentication and versioned URLs', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ data: [{ id: 'claude-a' }], has_more: true, last_id: 'claude-a' }))
    .mockResolvedValueOnce(Response.json({ data: [{ id: 'claude-b' }], has_more: false, last_id: 'claude-b' }))
  vi.stubGlobal('fetch', fetchMock)
  expect((await listModels({ ...config, baseUrl: 'https://api.anthropic.com/v1', api: 'anthropic-messages' })).ids).toEqual(['claude-a', 'claude-b'])
  expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['https://api.anthropic.com/v1/models', 'https://api.anthropic.com/v1/models?after_id=claude-a'])
  expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' })
  expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Authorization')
})

it('rejects repeated native pagination cursors', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({ data: [{ id: 'a' }], has_more: true, last_id: 'a' })))
  await expect(listModels({ ...config, api: 'anthropic-messages' })).rejects.toThrow('分页')
  expect(fetch).toHaveBeenCalledTimes(2)
})
