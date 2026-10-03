import { afterEach, expect, it, vi } from 'vitest'
import { create, cleanup } from './helpers'

const draft = { name: '自定义', baseUrl: 'https://another.example.com/v1', model: 'model-two', apiKey: 'new-private-key' }
/** 构造完整 SSE 测试回复，供 Models 保存成功路径验证使用，不访问真实服务。 */
function response(): Response {
  return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); cleanup() })

it('tests the exact candidate before saving, encrypts secrets and selects the new model', async () => {
  const { models, store } = await create()
  const fetchMock = vi.fn().mockImplementation(async () => response())
  vi.stubGlobal('fetch', fetchMock)
  const state = await models.testAndSave(draft)
  expect(state.models).toHaveLength(2)
  expect(state.config.model).toBe('model-two')
  const [url, options] = fetchMock.mock.calls[0]
  expect(url).toBe(`${draft.baseUrl}/chat/completions`)
  expect(JSON.parse(options.body)).toMatchObject({ model: draft.model, max_tokens: 16, stream: true })
  expect(JSON.parse(options.body)).not.toHaveProperty('thinking')
  expect(options.headers.Authorization).toBe('Bearer new-private-key')
  expect(JSON.stringify(state)).not.toContain('new-private-key')
  expect(JSON.stringify(store.state)).not.toContain('new-private-key')
})

it('retains the old configuration on HTTP, malformed stream and empty response failures', async () => {
  const { models, store } = await create()
  const before = structuredClone(store.state)
  for (const reply of [new Response('invalid', { status: 401 }), new Response('data: broken\n\n'), new Response('data: [DONE]\n\n')]) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply))
    await expect(models.testAndSave(draft)).rejects.toThrow('连通测试未通过')
    expect(store.state).toEqual(before)
  }
})

it('ends a test after 15 seconds even when the service keeps sending heartbeats', async () => {
  const { models, store } = await create()
  const before = structuredClone(store.state)
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn((_url, options) => Promise.resolve(new Response(new ReadableStream({ start(stream) {
    const timer = setInterval(() => stream.enqueue(new TextEncoder().encode(': heartbeat\n\n')), 1_000)
    options.signal.addEventListener('abort', () => { clearInterval(timer); stream.error(new DOMException('aborted', 'AbortError')) })
  } })))))
  const assertion = expect(models.testAndSave(draft)).rejects.toThrow('响应超时')
  await vi.advanceTimersByTimeAsync(15_000)
  await assertion
  expect(store.state).toEqual(before)
})

it('reuses an existing key when the edit field is blank and changes only that account profile', async () => {
  const { models, store } = await create()
  const fetchMock = vi.fn().mockImplementation(async () => response())
  vi.stubGlobal('fetch', fetchMock)
  const id = store.snapshot().activeModelId!
  await models.testAndSave({ ...draft, id, apiKey: '' })
  expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer private-key')
  expect(store.snapshot().models).toHaveLength(1)
  expect((await models.selected()).model).toBe(draft.model)
})

it('selects an owned profile and rejects another account profile or logged-out settings', async () => {
  const { models, store, auth } = await create()
  const oldId = store.snapshot().activeModelId!
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response()))
  await models.testAndSave(draft)
  store.apply({ type: 'model:select', id: oldId })
  expect((await models.selected()).model).toBe('test')
  auth.logout()
  await expect(models.selected()).rejects.toThrow('请先登录')
  await auth.register({ username: 'another', password: 'another-password' })
  expect(store.snapshot().models).toEqual([])
  expect(() => store.apply({ type: 'model:select', id: oldId })).toThrow('不存在')
  await expect(models.testAndSave({ ...draft, id: oldId })).rejects.toThrow('不存在')
})
