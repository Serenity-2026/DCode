import { StateRepository } from '../../src/main/repositories/state-repository'
import { afterEach, expect, it, vi } from 'vitest'
import { listModels } from '../../src/main/infrastructure/model-client'
import { create, cleanup } from './helpers'
import { modelEfforts, resolveEffort, reasoningEfforts } from '../../src/shared/context'
import { StateService } from '../../src/main/services/state-service'

const draft = { name: '自定义服务', baseUrl: 'https://another.example.com/v1', apiKey: 'new-private-key' }
/** 用真实 /models 的 data[].id 格式构造服务目录，不替代生产中的模型发现。 */
function response(ids = ['gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol']): Response {
  return Response.json({ data: ids.map(id => ({ id, object: 'model' })) })
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); cleanup() })

it('imports no environment service unless both URL and key are configured', async () => {
  for (const initial of [{ baseUrl: '', apiKey: '' }, { baseUrl: '', apiKey: 'private-key' }, { baseUrl: 'https://example.com/v1', apiKey: '' }]) {
    const { store } = await create({ ...initial, model: 'test' })
    expect(store.snapshot().providers).toEqual([])
    expect(store.snapshot().config.configured).toBe(false)
  }
})

it('saves and restores explicit native protocol and follows the selected service instead of model names', async () => {
  const { store, models, path } = await create()
  const fetchMock = vi.fn().mockImplementation(async () => response(['claude-through-gateway']))
  vi.stubGlobal('fetch', fetchMock)
  const native = await models.testAndSave({ ...draft, api: 'anthropic-messages' })
  expect(native.providers[1].api).toBe('anthropic-messages')
  expect(await models.selected()).toMatchObject({ api: 'anthropic-messages', model: 'claude-through-gateway' })
  expect(fetchMock.mock.calls[0][0]).toBe(`${draft.baseUrl}/models`)
  expect(fetchMock.mock.calls[0][1].headers['x-api-key']).toBe(draft.apiKey)
  await models.testAndSave({ ...draft, id: native.activeProviderId!, apiKey: '' })
  expect((await models.selected()).api).toBe('anthropic-messages')
  const restored = new StateService(new StateRepository(path))
  restored.authenticate(store.requireUser().id)
  expect(restored.snapshot().providers[1].api).toBe('anthropic-messages')
  const gateway = await models.testAndSave({ ...draft, api: 'openai-completions' })
  expect(await models.selected()).toMatchObject({ api: 'openai-completions', model: 'claude-through-gateway' })
  store.apply({ type: 'model:select', providerId: native.activeProviderId!, model: 'claude-through-gateway' })
  expect((await models.selected()).api).toBe('anthropic-messages')
  store.apply({ type: 'model:select', providerId: gateway.activeProviderId!, model: 'claude-through-gateway' })
  expect((await models.selected()).api).toBe('openai-completions')
  delete store.requireUser().providers[0].api
  store.apply({ type: 'model:select', providerId: store.requireUser().providers[0].id, model: 'test' })
  expect((await models.selected()).api).toBe('openai-completions')
  const before = structuredClone(store.state)
  await expect(models.testAndSave({ ...draft, api: 'bad' as never })).rejects.toThrow('协议无效')
  expect(store.state).toEqual(before)
})

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
  expect((await listModels(draft)).ids).toEqual(['vendor/custom', 'another-model'])
})

it('shows only actual model levels and sends selected levels without mapping', async () => {
  const { models, store } = await create()
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({ data: [
    { id: 'detailed', context_window: 1048576, effort: { supported_levels: ['max', 'low', 'high', 'invented', 'max'], default_level: 'high' } },
    { id: 'plain', context_window: -2, effort: { supported_levels: [] } }
  ] })))
  const snapshot = await models.testAndSave(draft)
  expect(snapshot.providers[1].modelDetails).toEqual({ detailed: { contextWindow: 1048576, reasoningEfforts: ['max', 'low', 'high'], defaultEffort: 'high' }, plain: { reasoningEfforts: [] } })
  expect(modelEfforts(snapshot.providers[1].modelDetails?.detailed)).toEqual(['low', 'high', 'max'])
  expect(store.snapshot().reasoningEffort).toBe('high')
  for (const effort of ['low', 'high', 'max'] as const) {
    store.apply({ type: 'reasoning-effort', effort })
    expect(store.snapshot().reasoningEffort).toBe(effort)
    expect((await models.selected()).reasoningEffort).toBe(effort)
  }
  const before = structuredClone(store.state)
  for (const effort of ['medium', 'ultra', 'invented', null] as const) {
    expect(() => store.apply({ type: 'reasoning-effort', effort: effort as never })).toThrow('不支持此强度')
    expect(store.state).toEqual(before)
  }
  store.apply({ type: 'model:select', providerId: snapshot.activeProviderId!, model: 'plain' })
  expect(store.snapshot().reasoningEffort).toBeNull()
  expect((await models.selected()).reasoningEffort).toBeNull()
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


it('reads window aliases, ignores invalid values and retains verified metadata when a refresh omits it', async () => {
  const { models, store } = await create()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: [
    { id: 'window', context_window: 65536 },
    { id: 'length', context_window: -1, context_length: 131072 },
    { id: 'nested', top_provider: { context_length: 262144 } },
    { id: 'unknown', context_length: '32768' }
  ] })))
  const snapshot = await models.testAndSave(draft)
  expect(snapshot.providers[1].modelDetails).toEqual({ window: { contextWindow: 65536 }, length: { contextWindow: 131072 }, nested: { contextWindow: 262144 }, unknown: {} })
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response(['window', 'length', 'nested', 'unknown'])))
  await models.refresh()
  expect(store.snapshot().providers[1].modelDetails).toEqual(snapshot.providers[1].modelDetails)
})

it('preserves supported effort levels and resolves service defaults', () => {
  for (const effort of reasoningEfforts) expect(resolveEffort(effort, { reasoningEfforts: [...reasoningEfforts] })).toBe(effort)
  expect(resolveEffort(null, { reasoningEfforts: ['low', 'high', 'max'], defaultEffort: 'low' })).toBe('low')
  expect(resolveEffort('ultra')).toBeNull()
  expect(resolveEffort('medium', { reasoningEfforts: [] })).toBeNull()
})

it('keeps independent model and service choices, repairs changed catalogs and restores them on restart', async () => {
  const { store, models, auth, path } = await create()
  const catalog = () => Response.json({ data: [
    { id: 'three', effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' } },
    { id: 'five', effort: { supported_levels: ['low', 'medium', 'high', 'max', 'ultra'], default_level: 'medium' } },
    { id: 'one', effort: { supported_levels: ['high'] } },
    { id: 'unknown' }
  ] })
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => catalog()))
  const first = (await models.testAndSave(draft)).activeProviderId!
  store.apply({ type: 'reasoning-effort', effort: 'max' })
  store.apply({ type: 'model:select', providerId: first, model: 'five' })
  expect(store.snapshot().reasoningEffort).toBe('medium')
  store.apply({ type: 'reasoning-effort', effort: 'ultra' })
  store.apply({ type: 'model:select', providerId: first, model: 'three' })
  expect(store.snapshot().reasoningEffort).toBe('max')
  const second = (await models.testAndSave({ ...draft, name: 'second' })).activeProviderId!
  expect(store.snapshot().reasoningEffort).toBe('high')
  store.apply({ type: 'reasoning-effort', effort: 'low' })
  store.apply({ type: 'model:select', providerId: first, model: 'five' })
  expect(store.snapshot().reasoningEffort).toBe('ultra')
  await models.refresh()
  expect(store.snapshot().reasoningEffort).toBe('ultra')
  await models.testAndSave({ ...draft, id: first, apiKey: '' })
  expect(store.snapshot().reasoningEffort).toBe('ultra')
  const restored = new StateService(new StateRepository(path))
  restored.authenticate(store.requireUser().id)
  expect(restored.snapshot().reasoningEffort).toBe('ultra')
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({ data: [
    { id: 'three', effort: { supported_levels: ['low', 'high', 'max'] } },
    { id: 'five', effort: { supported_levels: ['low', 'medium', 'high'] } },
    { id: 'one', effort: { supported_levels: ['high'] } }, { id: 'unknown' }
  ] })))
  await models.refresh()
  expect(store.snapshot().reasoningEffort).toBe('high')
  expect(store.requireUser().providers.find(p => p.id === first)?.selectedEfforts?.five).toBe('high')
  store.apply({ type: 'model:select', providerId: first, model: 'one' })
  expect(store.snapshot().reasoningEffort).toBe('high')
  store.apply({ type: 'model:select', providerId: first, model: 'unknown' })
  expect((await models.selected()).reasoningEffort).toBeNull()
  auth.logout()
  await auth.register({ username: 'independent', password: 'another-password' })
  expect(store.snapshot().providers).toEqual([])
  expect(store.snapshot().reasoningEffort).toBeNull()
  expect(store.state.users[0].providers.find(p => p.id === second)?.selectedEfforts?.three).toBe('low')
})
