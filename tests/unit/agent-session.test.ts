import { StateRepository } from '../../src/main/repositories/state-repository'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentSession } from '../../src/main/services/agent-session'
import { StateService } from '../../src/main/services/state-service'
import type { StreamEvent } from '../../src/shared/types'
import { create, cleanup, config, createAgent, unexpectedTaskError } from './helpers'
import { echoTool, openAIResponse, testCall } from './llm-fixtures'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); cleanup() })

it('retains tool records by call ID across parallel groups, serial barriers and persistence', async () => {
  const { store, path } = await create()
  const releases = new Map<string, () => void>()
  const events: StreamEvent[] = []
  const execute = async (input: Record<string, unknown>) => {
    await new Promise<void>(resolve => releases.set(input.text as string, resolve))
    if (input.text === 'b') throw new Error('工具失败')
    return { content: [{ type: 'text' as const, text: '完成' }], details: undefined }
  }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(openAIResponse('准备执行', [testCall('a', 'a'), testCall('b', 'b'), { ...testCall('c', 'c'), name: 'finish' }]))
    .mockResolvedValueOnce(openAIResponse('全部完成')))
  const agent = createAgent([{ ...echoTool, executionMode: 'parallel', execute }, { ...echoTool, name: 'finish', execute }])
  const session = new AgentSession(store, event => events.push(event), agent, unexpectedTaskError)
  const snapshot = session.send({ content: '执行工具' }, config)
  try {
    await vi.waitFor(() => expect(releases.size).toBe(2))
    expect(events.at(-1)).toMatchObject({ conversationId: snapshot.activeConversationId, message: { toolExecutions: [{ id: 'a', name: 'echo', status: 'running' }, { id: 'b', name: 'echo', status: 'running' }] } })
    expect(events.at(-1)!.message.content).toBe('准备执行')
    releases.get('b')!()
    await vi.waitFor(() => expect(events.at(-1)!.message.toolExecutions).toEqual([{ id: 'a', name: 'echo', status: 'running' }, { id: 'b', name: 'echo', status: 'error' }]))
    expect(events.find(event => event.message.toolExecutions?.length === 2)!.message.toolExecutions!.every(tool => tool.status === 'running')).toBe(true)
    expect(releases.has('c')).toBe(false)
    releases.get('a')!()
    await vi.waitFor(() => expect(releases.has('c')).toBe(true))
    expect(events.at(-1)!.message.toolExecutions).toEqual([{ id: 'a', name: 'echo', status: 'complete' }, { id: 'b', name: 'echo', status: 'error' }, { id: 'c', name: 'finish', status: 'running' }])
    releases.get('c')!()
    await agent.waitForIdle()
    expect(events.at(-1)!.message.status).toBe('complete')
    expect(events.at(-1)!.message.toolExecutions?.map(tool => tool.status)).toEqual(['complete', 'error', 'complete'])
    expect(new StateRepository(path).state.conversations[0].messages[1].toolExecutions).toEqual(events.at(-1)!.message.toolExecutions)
  } finally { agent.abort(); await agent.waitForIdle() }
})

it.each(['stopped', 'error'] as const)('settles tool records when the task ends as %s', async outcome => {
  const { store } = await create()
  const events: StreamEvent[] = []
  let release!: () => void
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(openAIResponse('', [testCall('a')])).mockRejectedValueOnce(new Error('模型失败')))
  const agent = createAgent([{ ...echoTool, execute: async () => {
    await new Promise<void>(resolve => { release = resolve })
    return { content: [{ type: 'text', text: '结果' }], details: undefined }
  } }])
  const session = new AgentSession(store, event => events.push(event), agent, unexpectedTaskError)
  session.send({ content: '执行工具' }, config)
  try {
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(events.at(-1)!.message.toolExecutions).toEqual([{ id: 'a', name: 'echo', status: 'running' }])
    if (outcome === 'stopped') await session.stop()
    else { release(); await agent.waitForIdle() }
    expect(events.at(-1)!.message.status).toBe(outcome)
    expect(events.at(-1)!.message.toolExecutions).toEqual([{ id: 'a', name: 'echo', status: outcome === 'stopped' ? 'stopped' : 'complete' }])
  } finally { agent.abort(); await agent.waitForIdle() }
})

it('blocks concurrent sends and saves partial content on cancellation', async () => {
  const { store, path } = await create()
  let received!: () => void
  const firstDelta = new Promise<void>(resolve => { received = resolve })
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"部分回复"}}]}\n\n'))
    options.signal.addEventListener('abort', () => controller.error(new DOMException('cancelled', 'AbortError')))
  } }))))
  const session = new AgentSession(store, event => { if (event.message.content) received() }, createAgent(), unexpectedTaskError)
  session.send({ content: '请回答' }, config)
  expect(() => session.send({ content: '重复发送' }, config)).toThrow('先停止')
  await firstDelta
  const state = await session.stop()
  expect(session.busy).toBe(false)
  expect(state.conversations[0].messages[1]).toMatchObject({ status: 'stopped', content: '部分回复' })
  expect(new StateService(new StateRepository(path)).state.conversations[0].messages).toHaveLength(2)
})

it('marks abnormal EOF as error and persists the partial answer', async () => {
  const { store, path } = await create()
  let finish!: (event: StreamEvent) => void
  const completed = new Promise<StreamEvent>(resolve => { finish = resolve })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"已收到的文本"}}]}\n\n')))
  const session = new AgentSession(store, event => { if (event.message.status !== 'streaming') finish(event) }, createAgent(), unexpectedTaskError)
  session.send({ content: '测试断流' }, config)
  expect((await completed).message).toMatchObject({ status: 'error', content: '已收到的文本' })
  expect(new StateService(new StateRepository(path)).state.conversations[0].messages[1].error).toContain('连接中断')
  expect(session.busy).toBe(false)
})

it('requires credentials before creating a conversation', async () => {
  const { store } = await create()
  const session = new AgentSession(store, () => {}, createAgent(), unexpectedTaskError)
  expect(() => session.send({ content: 'hi' }, { ...config, apiKey: '' })).toThrow('API 密钥')
  expect(store.state.conversations).toHaveLength(0)
})

it('reloads the selected conversation without replaying tool context from another run', async () => {
  const { store } = await create()
  const fetchMock = vi.fn().mockResolvedValueOnce(openAIResponse('', [testCall('a')])).mockResolvedValueOnce(openAIResponse('第一答'))
    .mockResolvedValueOnce(openAIResponse('另一答')).mockResolvedValueOnce(openAIResponse('追问答'))
  vi.stubGlobal('fetch', fetchMock)
  const agent = createAgent([echoTool])
  const session = new AgentSession(store, () => {}, agent, unexpectedTaskError)
  session.send({ content: '第一问' }, config)
  const firstId = store.state.activeConversationId!
  await agent.waitForIdle()
  store.apply({ type: 'conversation:select', id: null })
  session.send({ content: '另一会话' }, config)
  await agent.waitForIdle()
  const other = JSON.parse(fetchMock.mock.calls[2][1].body).messages
  expect(other.map((message: { role: string }) => message.role)).toEqual(['system', 'user'])
  expect(JSON.stringify(other)).not.toContain('第一问')
  store.apply({ type: 'conversation:select', id: firstId })
  session.send({ content: '追问' }, config)
  await agent.waitForIdle()
  const followup = JSON.parse(fetchMock.mock.calls[3][1].body).messages
  expect(followup.slice(1)).toEqual([{ role: 'user', content: '第一问' }, { role: 'assistant', content: '第一答' }, { role: 'user', content: '追问' }])
  expect(JSON.stringify(followup)).not.toContain('另一会话')
})

it('stops before model startup and waits until the stopped message is persisted', async () => {
  const { store, path } = await create()
  vi.stubGlobal('fetch', vi.fn())
  const session = new AgentSession(store, () => {}, createAgent(), unexpectedTaskError)
  session.send({ content: '立即停止' }, config)
  const snapshot = await session.stop()
  expect(fetch).not.toHaveBeenCalled()
  expect(session.busy).toBe(false)
  expect(snapshot.conversations[0].messages[1].status).toBe('stopped')
  expect(new StateRepository(path).state.conversations[0].messages[1].status).toBe('stopped')
})

it('finishes session persistence when a tool never cooperates with cancellation', async () => {
  const { store, path } = await create()
  let started!: () => void
  const running = new Promise<void>(resolve => { started = resolve })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(openAIResponse('准备', [testCall('a')])) )
  const session = new AgentSession(store, () => {}, createAgent([{ ...echoTool, execute: async () => { started(); return new Promise<never>(() => {}) } }]), unexpectedTaskError)
  session.send({ content: '工具取消' }, config)
  await running
  const snapshot = await session.stop()
  expect(snapshot.conversations[0].messages[1]).toMatchObject({ status: 'stopped', content: '准备' })
  expect(new StateRepository(path).state.conversations[0].messages[1].status).toBe('stopped')
  expect(session.busy).toBe(false)
  expect(fetch).toHaveBeenCalledOnce()
})

it('persists setup failures instead of leaving a streaming placeholder', async () => {
  const { store, path } = await create()
  const agent = createAgent()
  const emit = vi.fn()
  const report = vi.fn()
  const session = new AgentSession(store, emit, agent, report, { setDirectory: () => { throw new Error('目录设置失败') } })
  expect(() => session.send({ content: '开始' }, config)).toThrow('目录设置失败')
  expect(emit.mock.calls.at(-1)?.[0].message).toMatchObject({ status: 'error', error: '目录设置失败' })
  expect(new StateRepository(path).state.conversations[0].messages[1]).toMatchObject({ status: 'error', error: '目录设置失败' })
  expect(session.busy).toBe(false)
  expect(report).not.toHaveBeenCalled()
})

it('reports failed final persistence and retries saving on an idle stop', async () => {
  const { store, path } = await create()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(openAIResponse('部分正文')))
  const agent = createAgent()
  const emit = vi.fn()
  const report = vi.fn()
  const session = new AgentSession(store, emit, agent, report)
  session.send({ content: '开始' }, config)
  const save = vi.spyOn(store, 'save').mockImplementation(() => { throw new Error('磁盘已满') })
  await expect(agent.waitForIdle()).rejects.toThrow('磁盘已满')
  expect(agent.state.outcome).toBe('error')
  expect(emit.mock.calls.at(-1)?.[0].message).toMatchObject({ status: 'error', content: '部分正文', error: expect.stringContaining('保存失败：磁盘已满') })
  await vi.waitFor(() => expect(report).toHaveBeenCalledOnce())
  expect(report.mock.calls[0][0].message).toContain('磁盘已满')
  expect(session.busy).toBe(false)
  save.mockRestore()
  await session.stop()
  expect(new StateRepository(path).state.conversations[0].messages[1]).toMatchObject({ status: 'error', content: '部分正文' })
})

it('keeps a recovered task failure in the conversation without an extra application alert', async () => {
  const { store, path } = await create()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(openAIResponse('正文')))
  const agent = createAgent()
  const report = vi.fn()
  const session = new AgentSession(store, () => {}, agent, report)
  session.send({ content: '开始' }, config)
  vi.spyOn(store, 'save').mockImplementationOnce(() => { throw new Error('暂时无法保存') })
  await expect(agent.waitForIdle()).rejects.toThrow('暂时无法保存')
  await Promise.resolve()
  expect(new StateRepository(path).state.conversations[0].messages[1]).toMatchObject({ status: 'error', content: '正文', error: '暂时无法保存' })
  expect(session.busy).toBe(false)
  expect(report).not.toHaveBeenCalled()
})

it('reports failed terminal delivery and persists the error without an unhandled task rejection', async () => {
  const { store, path } = await create()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(openAIResponse('已完成正文')))
  const agent = createAgent()
  const report = vi.fn()
  const session = new AgentSession(store, event => { if (event.message.status !== 'streaming') throw new Error('界面发送失败') }, agent, report)
  session.send({ content: '开始' }, config)
  await expect(agent.waitForIdle()).rejects.toThrow('界面发送失败')
  await vi.waitFor(() => expect(report).toHaveBeenCalledOnce())
  expect(report.mock.calls[0][0].message).toContain('界面通知失败：界面发送失败')
  expect(new StateRepository(path).state.conversations[0].messages[1]).toMatchObject({ status: 'error', error: '界面发送失败' })
  await session.stop()
  expect(new StateRepository(path).state.conversations[0].messages[1].error).toContain('界面通知失败')
})
