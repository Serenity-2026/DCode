import { afterEach, expect, it, vi } from 'vitest'
import { Agent } from '../../src/main/services/agent'
import { AgentLoop } from '../../src/main/services/agent-loop'
import { AgentSession } from '../../src/main/services/agent-session'
import { StateRepository } from '../../src/main/repositories/state-repository'
import { ToolExecutionError, type AgentTool, type AgentToolResult } from '../../src/main/domain/llm'
import type { StreamEvent, ModelApi } from '../../src/shared/types'
import { create, cleanup, createAgent, config } from './helpers'
import { anthropicResponse, echoTool, openAIResponse, testCall } from './llm-fixtures'

afterEach(() => { vi.unstubAllGlobals(); cleanup() })

it.each<ModelApi>(['openai-completions', 'anthropic-messages'])('preserves result blocks and details and explicit failure through %s', async api => {
  const response = api === 'anthropic-messages' ? anthropicResponse : openAIResponse
  const failed: AgentToolResult = {
    content: [{ type: 'text', text: '失败输出' }, { type: 'image', data: 'cGlj', mimeType: 'image/png' }, { type: 'text', text: '补充说明' }],
    details: { exitCode: 7, localOnly: 'metadata-secret' }, isError: true
  }
  const execute = vi.fn<AgentTool['execute']>()
    .mockResolvedValueOnce({ content: [{ type: 'text', text: '成功' }], details: { localOnly: 'metadata-secret' } })
    .mockResolvedValueOnce(failed)
    .mockRejectedValueOnce(new ToolExecutionError('可公开错误'))
    .mockResolvedValueOnce({ content: [], details: undefined, isError: false })
  const fetchMock = vi.fn().mockResolvedValueOnce(response('', ['a', 'b', 'c', 'd'].map(id => testCall(id)))).mockResolvedValueOnce(response('完成'))
  vi.stubGlobal('fetch', fetchMock)
  const agent = createAgent([{ ...echoTool, execute }])
  const ended: boolean[] = []
  agent.subscribe(event => { if (event.type === 'tool_execution_end') ended.push(event.result.isError) })
  await agent.prompt({ ...config, api }, { role: 'user', content: '执行' })
  const results = agent.state.messages.filter(message => message.role === 'toolResult')
  expect(results.map(result => result.isError)).toEqual([false, true, true, false])
  expect(ended).toEqual([false, true, true, false])
  expect(results[1]).toMatchObject(failed)
  expect(results[2]).toMatchObject({ content: [{ type: 'text', text: '可公开错误' }], details: undefined })
  const request = JSON.parse(fetchMock.mock.calls[1][1].body)
  expect(JSON.stringify(request)).not.toContain('metadata-secret')
  if (api === 'anthropic-messages') {
    const blocks = request.messages.at(-1).content
    expect(blocks.map((block: { is_error: boolean }) => block.is_error)).toEqual([false, true, true, false])
    expect(blocks[1].content).toEqual([{ type: 'text', text: '失败输出' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cGlj' } }, { type: 'text', text: '补充说明' }])
  } else {
    expect(JSON.parse(request.messages.find((message: { tool_call_id?: string }) => message.tool_call_id === 'b').content)).toEqual({ error: '失败输出\n补充说明' })
    expect(request.messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,cGlj' } }] })
  }
  expect(agent.state.outcome).toBe('complete')
})

it.each(['legacy string', { content: [{ type: 'text', text: 1 }], details: undefined }])('turns malformed tool results into errors without accepting string compatibility (%j)', async returned => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(openAIResponse('', [testCall('a')])).mockResolvedValueOnce(openAIResponse('完成')))
  const agent = createAgent([{ ...echoTool, execute: async () => returned as unknown as AgentToolResult }])
  await agent.prompt(config, { role: 'user', content: '执行' })
  expect(agent.state.messages.find(message => message.role === 'toolResult')).toMatchObject({ content: [{ type: 'text', text: '工具执行失败。' }], isError: true })
})

it.each<ModelApi>(['openai-completions', 'anthropic-messages'])('executes ordered tools and continues for multiple %s turns', async api => {
  const response = api === 'anthropic-messages' ? anthropicResponse : openAIResponse
  const execute = vi.fn(echoTool.execute)
  const fetchMock = vi.fn().mockResolvedValueOnce(response('先检查。', [testCall('a', '一'), testCall('b', '二')], '计划'))
    .mockResolvedValueOnce(response('', [testCall('c', '三')])).mockResolvedValueOnce(response('最终答案'))
  vi.stubGlobal('fetch', fetchMock)
  let content = ''
  const agent = createAgent([{ ...echoTool, execute }])
  agent.replaceMessages([{ role: 'system', content: '提示' }])
  agent.subscribe(event => { if (event.type === 'message_update') content += event.delta.content || '' })
  await agent.prompt({ ...config, api }, { role: 'user', content: '问题' })
  expect(agent.state.outcome).toBe('complete')
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
  const agent = createAgent([{ ...echoTool, execute }])
  await agent.prompt({ ...config, api }, { role: 'user', content: '问题' })
  expect(agent.state.outcome).toBe('complete')
  expect(execute).toHaveBeenCalledOnce()
  const messages = JSON.parse(fetchMock.mock.calls[1][1].body).messages
  expect(JSON.stringify(messages)).not.toContain('private-key')
  if (api === 'anthropic-messages') expect(messages.at(-1).content.map((block: { is_error: boolean }) => block.is_error)).toEqual([true, true, true])
  else expect(messages.filter((message: { role: string }) => message.role === 'tool').map((message: { content: string }) => JSON.parse(message.content).error)).toEqual(['工具未注册。', '工具参数不符合 JSON Schema。', '工具执行失败。'])
})

it('stops during a tool and never executes later calls or sends another model request', async () => {
  let started!: () => void
  const running = new Promise<void>(resolve => { started = resolve })
  const execute = vi.fn<AgentTool['execute']>(async () => { started(); return new Promise<never>(() => {}) })
  const fetchMock = vi.fn().mockResolvedValue(openAIResponse('', [testCall('a'), testCall('b')]))
  vi.stubGlobal('fetch', fetchMock)
  const agent = createAgent([{ ...echoTool, execute }])
  const pending = agent.prompt(config, { role: 'user', content: '问题' })
  await running
  agent.abort()
  await pending
  expect(agent.state.outcome).toBe('stopped')
  expect(agent.state.pendingToolCalls).toEqual([])
  expect(execute).toHaveBeenCalledOnce()
  expect(execute.mock.calls[0][1].aborted).toBe(true)
  expect(fetchMock).toHaveBeenCalledOnce()
})

it('does not execute truncated calls and stops repeated IDs and unbounded loops', async () => {
  const execute = vi.fn(echoTool.execute)
  const agent = createAgent([{ ...echoTool, execute }])
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(openAIResponse('', [testCall('a')], '', 'length')))
  await agent.prompt(config, { role: 'user', content: '问题' })
  expect(agent.state.errorMessage).toContain('长度上限')
  expect(execute).not.toHaveBeenCalled()
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => openAIResponse('', [testCall('a')])) )
  agent.replaceMessages([])
  await agent.prompt(config, { role: 'user', content: '问题' })
  expect(agent.state.errorMessage).toContain('重复')
  expect(execute).toHaveBeenCalledOnce()
  execute.mockClear()
  let index = 0
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => openAIResponse('', [testCall(`call_${++index}`)])))
  agent.replaceMessages([])
  await agent.prompt(config, { role: 'user', content: '问题' })
  expect(agent.state.errorMessage).toContain('循环上限')
  expect(fetch).toHaveBeenCalledTimes(8)
  expect(execute).toHaveBeenCalledTimes(7)
})

it('rejects duplicate tool definitions and invalid schemas before starting', () => {
  const stream = vi.fn()
  const loop = new AgentLoop(stream)
  expect(() => new Agent(loop, [echoTool, echoTool])).toThrow('重复')
  expect(() => new Agent(loop, [{ ...echoTool, parameters: { type: 'string' } }])).toThrow('工具定义')
  expect(() => new Agent(loop, [{ ...echoTool, parameters: { type: 'object', misspelled: true } }])).toThrow()
  expect(stream).not.toHaveBeenCalled()
})

it('keeps the existing session lifecycle and text persistence when tools are used', async () => {
  const { store, path } = await create()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(openAIResponse('', [testCall('a')])).mockResolvedValueOnce(openAIResponse('最终正文')))
  let finish!: (event: StreamEvent) => void
  const done = new Promise<StreamEvent>(resolve => { finish = resolve })
  const session = new AgentSession(store, event => { if (event.message.status !== 'streaming') finish(event) }, createAgent([echoTool]))
  session.send({ content: '请调用工具' }, config)
  expect((await done).message).toMatchObject({ status: 'complete', content: '最终正文' })
  expect(session.busy).toBe(false)
  expect(new StateRepository(path).state.conversations[0].messages[1].content).toBe('最终正文')
  expect(store.state.schemaVersion).toBe(3)
})
