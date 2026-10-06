import { StateRepository } from '../../src/main/repositories/state-repository'
import { afterEach, expect, it, vi } from 'vitest'
import { Chat } from '../../src/main/services/chat-service'
import { StateService } from '../../src/main/services/state-service'
import type { StreamEvent } from '../../src/shared/types'
import { create, cleanup, config } from './helpers'

afterEach(() => { vi.unstubAllGlobals(); cleanup() })

it('blocks concurrent sends and saves partial content on cancellation', async () => {
  const { store, path } = await create()
  let received!: () => void
  const firstDelta = new Promise<void>(resolve => { received = resolve })
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"部分回复"}}]}\n\n'))
    options.signal.addEventListener('abort', () => controller.error(new DOMException('cancelled', 'AbortError')))
  } }))))
  const chat = new Chat(store, event => { if (event.message.content) received() })
  chat.send({ content: '请回答' }, config)
  expect(() => chat.send({ content: '重复发送' }, config)).toThrow('先停止')
  await firstDelta
  const state = await chat.stop()
  expect(chat.busy).toBe(false)
  expect(state.conversations[0].messages[1]).toMatchObject({ status: 'stopped', content: '部分回复' })
  expect(new StateService(new StateRepository(path)).state.conversations[0].messages).toHaveLength(2)
})

it('marks abnormal EOF as error and persists the partial answer', async () => {
  const { store, path } = await create()
  let finish!: (event: StreamEvent) => void
  const completed = new Promise<StreamEvent>(resolve => { finish = resolve })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"已收到的文本"}}]}\n\n')))
  const chat = new Chat(store, event => { if (event.message.status !== 'streaming') finish(event) })
  chat.send({ content: '测试断流' }, config)
  expect((await completed).message).toMatchObject({ status: 'error', content: '已收到的文本' })
  expect(new StateService(new StateRepository(path)).state.conversations[0].messages[1].error).toContain('连接中断')
  expect(chat.busy).toBe(false)
})

it('requires credentials before creating a conversation', async () => {
  const { store } = await create()
  const chat = new Chat(store, () => {})
  expect(() => chat.send({ content: 'hi' }, { ...config, apiKey: '' })).toThrow('API 密钥')
  expect(store.state.conversations).toHaveLength(0)
})
