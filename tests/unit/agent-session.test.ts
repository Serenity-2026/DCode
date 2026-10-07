import { StateRepository } from '../../src/main/repositories/state-repository'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentSession } from '../../src/main/services/agent-session'
import { StateService } from '../../src/main/services/state-service'
import type { StreamEvent } from '../../src/shared/types'
import { create, cleanup, config, createAgent } from './helpers'
import { echoTool, openAIResponse, testCall } from './llm-fixtures'

afterEach(() => { vi.unstubAllGlobals(); cleanup() })

it('blocks concurrent sends and saves partial content on cancellation', async () => {
  const { store, path } = await create()
  let received!: () => void
  const firstDelta = new Promise<void>(resolve => { received = resolve })
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"部分回复"}}]}\n\n'))
    options.signal.addEventListener('abort', () => controller.error(new DOMException('cancelled', 'AbortError')))
  } }))))
  const session = new AgentSession(store, event => { if (event.message.content) received() }, createAgent())
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
  const session = new AgentSession(store, event => { if (event.message.status !== 'streaming') finish(event) }, createAgent())
  session.send({ content: '测试断流' }, config)
  expect((await completed).message).toMatchObject({ status: 'error', content: '已收到的文本' })
  expect(new StateService(new StateRepository(path)).state.conversations[0].messages[1].error).toContain('连接中断')
  expect(session.busy).toBe(false)
})

it('requires credentials before creating a conversation', async () => {
  const { store } = await create()
  const session = new AgentSession(store, () => {}, createAgent())
  expect(() => session.send({ content: 'hi' }, { ...config, apiKey: '' })).toThrow('API 密钥')
  expect(store.state.conversations).toHaveLength(0)
})

it('reloads the selected conversation without replaying tool context from another run', async () => {
  const { store } = await create()
  const fetchMock = vi.fn().mockResolvedValueOnce(openAIResponse('', [testCall('a')])).mockResolvedValueOnce(openAIResponse('第一答'))
    .mockResolvedValueOnce(openAIResponse('另一答')).mockResolvedValueOnce(openAIResponse('追问答'))
  vi.stubGlobal('fetch', fetchMock)
  const agent = createAgent([echoTool])
  const session = new AgentSession(store, () => {}, agent)
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
  const session = new AgentSession(store, () => {}, createAgent())
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
  const session = new AgentSession(store, () => {}, createAgent([{ ...echoTool, execute: async () => { started(); return new Promise<string>(() => {}) } }]))
  session.send({ content: '工具取消' }, config)
  await running
  const snapshot = await session.stop()
  expect(snapshot.conversations[0].messages[1]).toMatchObject({ status: 'stopped', content: '准备' })
  expect(new StateRepository(path).state.conversations[0].messages[1].status).toBe('stopped')
  expect(session.busy).toBe(false)
  expect(fetch).toHaveBeenCalledOnce()
})
