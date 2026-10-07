import { readFileSync, writeFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { Chat } from '../../src/main/services/chat-service'
import { AgentLoop } from '../../src/main/services/agent-loop'
import { ToolRegistry } from '../../src/main/services/tool-registry'
import { ModelClient } from '../../src/main/infrastructure/model-client'
import { StateRepository } from '../../src/main/repositories/state-repository'
import { StateService } from '../../src/main/services/state-service'
import { contextMessages } from '../../src/shared/context'
import type { AgentTool, ModelGateway } from '../../src/main/domain/agent'
import type { StreamEvent, ToolCall } from '../../src/shared/types'
import { cleanup, config, create, createAgent } from './helpers'

const definition = { name: 'echo', description: '回传文本', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }
const call = (id: string, argumentsText = '{"text":"测试"}'): ToolCall => ({ id, name: 'echo', arguments: argumentsText })

/** 本地流响应走真实 HTTP/SSE 适配器，只有工具 handler 使用测试替身。 */
function response(content = '', calls: ToolCall[] = [], reasoning = ''): Response {
  const delta = { content, reasoning_content: reasoning, ...(calls.length ? { tool_calls: calls.map((item, index) => ({ index, id: item.id, type: 'function', function: { name: item.name, arguments: item.arguments } })) } : {}) }
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
}

/** 创建隔离聊天任务并等待其最终事件，避免靠固定等待时间判定完成。 */
async function send(agent: AgentLoop) {
  const data = await create()
  let finish!: (event: StreamEvent) => void
  const done = new Promise<StreamEvent>(resolve => { finish = resolve })
  const chat = new Chat(data.store, event => { if (event.message.status !== 'streaming') finish(event) }, agent)
  chat.send({ content: '验证工具循环' }, config)
  return { ...data, chat, done }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); cleanup() })

it('runs multiple rounds and ordered calls, sends matched results and persists the transcript', async () => {
  const order: string[] = []
  const tool: AgentTool = { definition, execute: async input => { order.push(input.text as string); return `结果:${input.text}` } }
  const fetchMock = vi.fn().mockResolvedValueOnce(response('先检查。', [call('a', '{"text":"一"}'), call('b', '{"text":"二"}')], '计划'))
    .mockResolvedValueOnce(response('', [call('c', '{"text":"三"}')]))
    .mockResolvedValueOnce(response('最终答案'))
  vi.stubGlobal('fetch', fetchMock)
  const { done, path, chat, store } = await send(createAgent([tool]))
  const final = (await done).message
  expect(final).toMatchObject({ status: 'complete', content: '先检查。最终答案', reasoning: '计划' })
  expect(order).toEqual(['一', '二', '三'])
  expect(final.agentRounds).toHaveLength(3)
  const second = JSON.parse(fetchMock.mock.calls[1][1].body)
  expect(second).toMatchObject({ tool_choice: 'auto', tools: [{ type: 'function', function: definition }] })
  expect(second.messages.slice(-3)).toEqual([
    { role: 'assistant', content: '先检查。', reasoning_content: '计划', tool_calls: ['a', 'b'].map((id, index) => ({ id, type: 'function', function: { name: 'echo', arguments: JSON.stringify({ text: index ? '二' : '一' }) } })) },
    { role: 'tool', tool_call_id: 'a', content: JSON.stringify({ ok: true, content: '结果:一' }) },
    { role: 'tool', tool_call_id: 'b', content: JSON.stringify({ ok: true, content: '结果:二' }) }
  ])
  expect(fetchMock.mock.calls[2][1].body).not.toContain('private-key')
  const reloaded = new StateService(new StateRepository(path))
  expect(reloaded.state.conversations[0].messages[1]).toEqual(final)
  expect(contextMessages(store.state.conversations[0], false)).toHaveLength(3)
  expect(contextMessages(store.state.conversations[0], false).at(-1)?.content).toBe(final.content)
  expect(chat.busy).toBe(false)
})

it('returns unknown, invalid and failed tools to the model without leaking handler errors', async () => {
  const execute = vi.fn(async () => { throw new Error('private-key') })
  const fetchMock = vi.fn().mockResolvedValueOnce(response('', [{ ...call('a'), name: 'shell' }, call('b', '{"text":1}'), call('c')]))
    .mockResolvedValueOnce(response('已处理工具错误'))
  vi.stubGlobal('fetch', fetchMock)
  const { done } = await send(createAgent([{ definition, execute }]))
  expect((await done).message.status).toBe('complete')
  expect(execute).toHaveBeenCalledOnce()
  const results = JSON.parse(fetchMock.mock.calls[1][1].body).messages.filter((item: { role: string }) => item.role === 'tool')
  expect(results).toHaveLength(3)
  expect(results.every((item: { content: string }) => JSON.parse(item.content).ok === false)).toBe(true)
  expect(JSON.stringify(results)).not.toContain('private-key')
})

it('stops during a tool, preserves the partial answer and skips later calls and model requests', async () => {
  let started!: () => void
  const running = new Promise<void>(resolve => { started = resolve })
  let handlerSignal!: AbortSignal
  const execute = vi.fn(async (_input, context) => { handlerSignal = context.signal; started(); return new Promise<string>(() => {}) })
  const fetchMock = vi.fn().mockResolvedValue(response('部分正文', [call('a'), call('b')]))
  vi.stubGlobal('fetch', fetchMock)
  const { chat, done, path } = await send(createAgent([{ definition, execute }]))
  await running
  await chat.stop()
  const message = (await done).message
  expect(message).toMatchObject({ status: 'stopped', content: '部分正文' })
  expect(message.agentRounds![0].toolCalls.map(item => item.status)).toEqual(['stopped', 'stopped'])
  expect(handlerSignal.aborted).toBe(true)
  expect(execute).toHaveBeenCalledOnce()
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(new StateRepository(path).state.conversations[0].messages[1]).toEqual(message)
})

it('stops before generation starts without requesting the model', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  const { chat, done } = await send(createAgent())
  await chat.stop()
  expect((await done).message.status).toBe('stopped')
  expect(fetchMock).not.toHaveBeenCalled()
})

it.each([{ maxRounds: 1, maxToolCalls: 32 }, { maxRounds: 8, maxToolCalls: 1 }])('enforces budgets before executing another batch: %j', async budget => {
  const execute = vi.fn(async () => 'ok')
  const fetchMock = vi.fn().mockResolvedValue(response('部分正文', [call('a'), call('b')]))
  vi.stubGlobal('fetch', fetchMock)
  const agent = new AgentLoop(new ModelClient(), new ToolRegistry([{ definition, execute }]), { ...budget, runTimeoutMs: 1000 })
  const { done } = await send(agent)
  expect((await done).message).toMatchObject({ status: 'error', content: '部分正文', error: expect.stringContaining('上限') })
  expect(execute).not.toHaveBeenCalled()
  expect(fetchMock).toHaveBeenCalledOnce()
})

it('rejects a reused call ID across rounds without repeating execution', async () => {
  const execute = vi.fn(async () => 'ok')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response('', [call('a')])).mockResolvedValueOnce(response('', [call('a')])) )
  const { done } = await send(createAgent([{ definition, execute }]))
  expect((await done).message).toMatchObject({ status: 'error', error: expect.stringContaining('重复') })
  expect(execute).toHaveBeenCalledOnce()
})

it('does not execute calls from an interrupted model response', async () => {
  const execute = vi.fn(async () => 'ok')
  const full = await response('', [call('a')]).text()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(full.replace('data: [DONE]\n\n', ''))))
  const { done } = await send(createAgent([{ definition, execute }]))
  expect((await done).message.status).toBe('error')
  expect(execute).not.toHaveBeenCalled()
})

it('refuses tool execution if the pre-execution checkpoint cannot be saved', async () => {
  const execute = vi.fn(async () => 'ok')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response('', [call('a')])) )
  const { store, done } = await send(createAgent([{ definition, execute }]))
  vi.spyOn(store, 'save').mockImplementation(() => { throw new Error('checkpoint failed') })
  expect((await done).message).toMatchObject({ status: 'error', error: 'checkpoint failed' })
  expect(execute).not.toHaveBeenCalled()
})

it('requires text in the final round even if an earlier round included text', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response('中间正文', [call('a')])).mockResolvedValueOnce(response()))
  const { done } = await send(createAgent([{ definition, execute: async () => 'ok' }]))
  expect((await done).message).toMatchObject({ status: 'error', content: '中间正文', error: expect.stringContaining('没有返回文本') })
})

it('marks interrupted executions stopped on restart and refuses malformed records without overwriting', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response('普通回答')))
  const { done, path } = await send(createAgent())
  await done
  const disk = JSON.parse(readFileSync(path, 'utf8'))
  const message = disk.conversations[0].messages[1]
  message.status = 'streaming'
  message.agentRounds[0].toolCalls = [{ call: call('a'), status: 'running' }, { call: call('b'), status: 'pending' }]
  writeFileSync(path, JSON.stringify(disk))
  const recovered = new StateService(new StateRepository(path)).state.conversations[0].messages[1]
  expect(recovered.status).toBe('stopped')
  expect(recovered.agentRounds![0].toolCalls.map(item => item.status)).toEqual(['stopped', 'stopped'])
  message.agentRounds[0].toolCalls[0].call.arguments = 123
  const malformed = JSON.stringify(disk)
  writeFileSync(path, malformed)
  expect(() => new StateRepository(path)).toThrow('无法读取')
  expect(readFileSync(path, 'utf8')).toBe(malformed)
})

it('enforces a total run deadline even when a model ignores cancellation', async () => {
  vi.useFakeTimers()
  const stream = vi.fn<ModelGateway['stream']>(async () => new Promise<never>(() => {}))
  const loop = new AgentLoop({ stream }, new ToolRegistry([]), { maxRounds: 8, maxToolCalls: 32, runTimeoutMs: 10 })
  const pending = loop.run(config, [], new AbortController().signal, { onRound: () => {}, onDelta: () => {}, onUpdate: () => {} })
  const assertion = expect(pending).rejects.toThrow('运行超时')
  await vi.advanceTimersByTimeAsync(10)
  await assertion
  expect(stream.mock.calls[0][2].aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
