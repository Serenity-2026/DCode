import { afterEach, expect, it, vi } from 'vitest'
import { AgentLoop } from '../../src/main/services/agent-loop'
import { Chat } from '../../src/main/services/chat-service'
import { StateRepository } from '../../src/main/repositories/state-repository'
import { toLlmMessages, type AgentTool } from '../../src/main/domain/llm'
import type { StreamEvent, ModelApi } from '../../src/shared/types'
import { create, cleanup, createAgent, config } from './helpers'
import { anthropicResponse, echoTool, openAIResponse, testCall } from './llm-fixtures'

afterEach(() => { vi.unstubAllGlobals(); cleanup() })

it.each<ModelApi>(['openai-completions', 'anthropic-messages'])('executes ordered tools and continues for multiple %s turns', async api => {
  const response = api === 'anthropic-messages' ? anthropicResponse : openAIResponse
  const execute = vi.fn(echoTool.execute)
  const fetchMock = vi.fn().mockResolvedValueOnce(response('先检查。', [testCall('a', '一'), testCall('b', '二')], '计划'))
    .mockResolvedValueOnce(response('', [testCall('c', '三')])).mockResolvedValueOnce(response('最终答案'))
  vi.stubGlobal('fetch', fetchMock)
  let content = ''
  await createAgent([{ ...echoTool, execute }]).run({ ...config, api }, toLlmMessages([{ role: 'system', content: '提示' }, { role: 'user', content: '问题' }]), new AbortController(), delta => { content += delta.content || '' })
  expect(content).toBe('先检查。最终答案')
  expect(execute.mock.calls.map(call => call[0])).toEqual([{ text: '一' }, { text: '二' }, { text: '三' }])
  const second = JSON.parse(fetchMock.mock.calls[1][1].body)
  if (api === 'anthropic-messages') {
    expect(second.messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '结果:一', is_error: false }, { type: 'tool_result', tool_use_id: 'b', content: '结果:二', is_error: false }] })
    expect(second.messages.at(-2).content[0]).toEqual({ type: 'thinking', thinking: '计划', signature: 'sig-signed' })
  } else {
    expect(second.messages.slice(-2)).toEqual([{ role: 'tool', tool_call_id: 'a', content: '结果:一' }, { role: 'tool', tool_call_id: 'b', content: '结果:二' }])
    expect(second.messages.at(-3).reasoning_content).toBe('计划')
  }
  expect(fetchMock).toHaveBeenCalledTimes(3)
})

it.each<ModelApi>(['openai-completions', 'anthropic-messages'])('feeds unknown, invalid and failed calls back through %s without executing invalid input', async api => {
  const response = api === 'anthropic-messages' ? anthropicResponse : openAIResponse
  const execute = vi.fn(async () => { throw new Error('private-key') })
  const fetchMock = vi.fn().mockResolvedValueOnce(response('', [{ ...testCall('a'), name: 'shell' }, { ...testCall('b'), arguments: '{"text":1}' }, testCall('c')]))
    .mockResolvedValueOnce(response('已处理工具错误'))
  vi.stubGlobal('fetch', fetchMock)
  await createAgent([{ ...echoTool, execute }]).run({ ...config, api }, [], new AbortController(), () => {})
  expect(execute).toHaveBeenCalledOnce()
  const messages = JSON.parse(fetchMock.mock.calls[1][1].body).messages
  expect(JSON.stringify(messages)).not.toContain('private-key')
  if (api === 'anthropic-messages') expect(messages.at(-1).content.map((block: { is_error: boolean }) => block.is_error)).toEqual([true, true, true])
  else expect(messages.filter((message: { role: string }) => message.role === 'tool').map((message: { content: string }) => JSON.parse(message.content).error)).toEqual(['工具未注册。', '工具参数不符合 JSON Schema。', '工具执行失败。'])
})

it('stops during a tool and never executes later calls or sends another model request', async () => {
  let started!: () => void
  const running = new Promise<void>(resolve => { started = resolve })
  const execute = vi.fn<AgentTool['execute']>(async () => { started(); return new Promise<string>(() => {}) })
  const fetchMock = vi.fn().mockResolvedValue(openAIResponse('', [testCall('a'), testCall('b')]))
  vi.stubGlobal('fetch', fetchMock)
  const controller = new AbortController()
  const pending = createAgent([{ ...echoTool, execute }]).run(config, [], controller, () => {})
  const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await running
  controller.abort()
  await assertion
  expect(execute).toHaveBeenCalledOnce()
  expect(execute.mock.calls[0][1].aborted).toBe(true)
  expect(fetchMock).toHaveBeenCalledOnce()
})

it('does not execute truncated calls and stops repeated IDs and unbounded loops', async () => {
  const execute = vi.fn(echoTool.execute)
  const agent = createAgent([{ ...echoTool, execute }])
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(openAIResponse('', [testCall('a')], '', 'length')))
  await expect(agent.run(config, [], new AbortController(), () => {})).rejects.toThrow('长度上限')
  expect(execute).not.toHaveBeenCalled()
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => openAIResponse('', [testCall('a')])) )
  await expect(agent.run(config, [], new AbortController(), () => {})).rejects.toThrow('重复')
  expect(execute).toHaveBeenCalledOnce()
  execute.mockClear()
  let index = 0
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => openAIResponse('', [testCall(`call_${++index}`)])))
  await expect(agent.run(config, [], new AbortController(), () => {})).rejects.toThrow('循环上限')
  expect(fetch).toHaveBeenCalledTimes(8)
  expect(execute).toHaveBeenCalledTimes(7)
})

it('rejects duplicate tool definitions and invalid schemas before starting', () => {
  const stream = vi.fn()
  expect(() => new AgentLoop(stream, [echoTool, echoTool])).toThrow('重复')
  expect(() => new AgentLoop(stream, [{ ...echoTool, parameters: { type: 'string' } }])).toThrow('工具定义')
  expect(() => new AgentLoop(stream, [{ ...echoTool, parameters: { type: 'object', misspelled: true } }])).toThrow()
  expect(stream).not.toHaveBeenCalled()
})

it('keeps the existing chat lifecycle and text persistence when tools are used', async () => {
  const { store, path } = await create()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(openAIResponse('', [testCall('a')])).mockResolvedValueOnce(openAIResponse('最终正文')))
  let finish!: (event: StreamEvent) => void
  const done = new Promise<StreamEvent>(resolve => { finish = resolve })
  const chat = new Chat(store, event => { if (event.message.status !== 'streaming') finish(event) }, createAgent([echoTool]))
  chat.send({ content: '请调用工具' }, config)
  expect((await done).message).toMatchObject({ status: 'complete', content: '最终正文' })
  expect(chat.busy).toBe(false)
  expect(new StateRepository(path).state.conversations[0].messages[1].content).toBe('最终正文')
  expect(store.state.schemaVersion).toBe(3)
})
