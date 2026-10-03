import { afterEach, expect, it, vi } from 'vitest'
import { listModels } from '../../src/main/models'
import { create, cleanup } from './helpers'

const draft = { name: '自定义服务', baseUrl: 'https://another.example.com/v1', apiKey: 'new-private-key' }
/** 用真实 /models 的 data[].id 格式构造服务目录，不替代生产中的模型发现。 */
function response(ids = ['gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol']): Response {
  return Response.json({ data: ids.map(id => ({ id, object: 'model' })) })
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); cleanup() })

it('uses the candidate URL and key to discover models before saving, without a chat request', async () => {
  const { models, store } = await create()
  const fetchMock = vi.fn().mockImplementation(async () => response())
  vi.stubGlobal('fetch', fetchMock)
  const state = await models.testAndSave(draft)
  expect(state.providers).toHaveLength(2)
  expect(state.config.model).toBe('gpt-6-astra')
  expect(state.providers[1].availableModels).toEqual(['gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol'])
  const [url, options] = fetchMock.mock.calls[0]
  expect(url).toBe(`${draft.baseUrl}/models`)
  expect(options.body).toBeUndefined()
  expect(options.redirect).toBe('error')
  expect(options.headers.Authorization).toBe('Bearer new-private-key')
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(state)).not.toContain('new-private-key')
  expect(JSON.stringify(store.state)).not.toContain('new-private-key')
})

it('retains the old service and selection on HTTP, malformed and empty model list failures', async () => {
  const { models, store } = await create()
  const before = structuredClone(store.state)
  for (const reply of [new Response('secret', { status: 401 }), new Response('broken'), response([]), Response.json({ data: [{ id: 123 }] }), Response.json({ other: [] })]) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply))
    await expect(models.testAndSave(draft)).rejects.toThrow('连通测试未通过')
    expect(store.state).toEqual(before)
  }
})

it('deduplicates actual model IDs without inventing default models', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(['vendor/custom', 'vendor/custom', 'another-model'])))
  expect(await listModels(draft)).toEqual(['vendor/custom', 'another-model'])
})

it('times out model discovery and leaves the original service unchanged', async () => {
  const { models, store } = await create()
  const before = structuredClone(store.state)
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  })))
  const assertion = expect(models.testAndSave(draft)).rejects.toThrow('获取模型列表超时')
  await vi.advanceTimersByTimeAsync(15_000)
  await assertion
  expect(store.state).toEqual(before)
})

it('reuses a saved key when the edit is blank and retains the selected model if still available', async () => {
  const { models, store } = await create()
  const fetchMock = vi.fn().mockImplementation(async () => response(['new-model', 'test']))
  vi.stubGlobal('fetch', fetchMock)
  const id = store.snapshot().activeProviderId!
  await models.testAndSave({ ...draft, id, apiKey: '' })
  expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer private-key')
  expect(store.snapshot().providers).toHaveLength(1)
  expect((await models.selected()).model).toBe('test')
})

it('refreshes catalogs, preserves valid selection and repairs a removed model without touching failed services', async () => {
  const { models, store } = await create()
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response()))
  await models.testAndSave(draft)
  const active = store.requireUser().providers[1].id
  store.apply({ type: 'model:select', providerId: active, model: 'gpt-6-sol' })
  let refreshed = await models.refresh()
  expect(refreshed.snapshot.selectedModel).toBe('gpt-6-sol')
  expect(refreshed.errors).toEqual([])
  vi.stubGlobal('fetch', vi.fn(url => url === `${draft.baseUrl}/models` ? Promise.resolve(response(['replacement'])) : Promise.resolve(new Response('', { status: 401 }))))
  refreshed = await models.refresh()
  expect(refreshed.snapshot.providers[0].availableModels).toEqual(['gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol'])
  expect(refreshed.snapshot.selectedModel).toBe('replacement')
  expect(refreshed.errors).toHaveLength(1)
  expect(JSON.stringify(refreshed)).not.toContain('private-key')
})

it('switches only between models returned for an owned service and rejects cross-account selection', async () => {
  const { models, store, auth } = await create()
  const oldId = store.snapshot().activeProviderId!
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response()))
  await models.testAndSave(draft)
  store.apply({ type: 'model:select', providerId: oldId, model: 'test' })
  store.apply({ type: 'fast-mode', enabled: true })
  expect(await models.selected()).toMatchObject({ model: 'test', fastMode: true, apiKey: 'private-key' })
  expect(() => store.apply({ type: 'model:select', providerId: oldId, model: 'invented-model' })).toThrow('模型不存在')
  auth.logout()
  await expect(models.selected()).rejects.toThrow('请先登录')
  await auth.register({ username: 'another', password: 'another-password' })
  expect(store.snapshot()).toMatchObject({ providers: [], fastMode: false })
  expect(() => store.apply({ type: 'model:select', providerId: oldId, model: 'test' })).toThrow('模型不存在')
  await expect(models.testAndSave({ ...draft, id: oldId })).rejects.toThrow('不存在')
})
