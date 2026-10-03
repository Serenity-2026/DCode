import { randomUUID } from 'node:crypto'
import type { ModelRefresh, ProviderDraft, Snapshot } from '../shared/types'
import { validateBaseUrl, type ModelConfig, type ProviderConfig } from './config'
import type { SecretCodec } from './secrets'
import { Store, textInput, type StoredUser } from './store'

/** 用账号服务的 URL 与密钥获取实际模型 ID，供 Models 保存验证与登录后刷新共用。 */
export async function listModels(config: ProviderConfig): Promise<string[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(`${config.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' },
      redirect: 'error', signal: controller.signal
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(response.status === 401 || response.status === 403 ? 'API 密钥无效或无权获取模型列表。' : response.status === 404 ? '服务的模型列表接口不存在，请检查服务地址。' : `获取模型列表失败（${response.status}）。`)
    }
    const payload: unknown = await response.json()
    const data = payload && typeof payload === 'object' ? (payload as { data?: unknown }).data : undefined
    if (!Array.isArray(data) || data.some(item => !item || typeof item.id !== 'string' || !item.id.trim())) throw new Error('服务返回的模型列表格式不正确。')
    const ids = [...new Set<string>(data.map(item => item.id))]
    if (!ids.length) throw new Error('该服务没有返回可用模型。')
    return ids
  } catch (error) {
    if (controller.signal.aborted) throw new Error('获取模型列表超时，请重试。')
    if (error instanceof TypeError) throw new Error('无法连接模型服务，请检查网络和服务地址。')
    if (error instanceof SyntaxError) throw new Error('服务返回的模型列表格式不正确。')
    throw error
  } finally { clearTimeout(timeout) }
}

/** 管理账号的服务和模型选择，依赖 Store 检查归属、Secrets 加密密钥、listModels 获取列表。 */
export class Models {
  /** 环境地址与密钥仅导入首个账号；模型列表在工作台登录后获取。 */
  constructor(private store: Store, private secrets: SecretCodec, private initial: ProviderConfig) {}

  /** 加密导入环境服务，由 Auth.register 调用；不内置或读取环境中的模型 ID。 */
  async bootstrap(): Promise<StoredUser['providers'][number] | null> {
    if (!this.initial.apiKey) return null
    return { id: randomUUID(), name: '环境默认', baseUrl: this.initial.baseUrl, availableModels: [], encryptedApiKey: await this.secrets.encrypt(this.initial.apiKey) }
  }

  /** 仅允许使用服务返回列表中的模型，解密当前服务密钥并为 Chat 组装单次请求配置。 */
  async selected(): Promise<ModelConfig> {
    const user = this.store.requireUser()
    const provider = user.providers.find(p => p.id === user.activeProviderId)
    if (!provider || !user.selectedModel || !provider.availableModels.includes(user.selectedModel)) throw new Error('请先配置服务并选择可用模型。')
    return { baseUrl: provider.baseUrl, model: user.selectedModel, fastMode: user.fastMode, apiKey: await this.secrets.decrypt(provider.encryptedApiKey) }
  }

  /** 获取当前账号各服务的列表；失败服务保留缓存，失效的模型选择改为返回列表的第一项。 */
  async refresh(): Promise<ModelRefresh> {
    const user = this.store.requireUser()
    const results = await Promise.all(user.providers.map(async provider => {
      try {
        const apiKey = await this.secrets.decrypt(provider.encryptedApiKey)
        return { provider, ids: await listModels({ baseUrl: provider.baseUrl, apiKey }), error: '' }
      } catch (error) { return { provider, ids: null, error: `${provider.name}：${error instanceof Error ? error.message : '获取模型列表失败。'}` } }
    }))
    if (results.some(r => r.ids)) this.store.transaction(() => {
      if (this.store.requireUser().id !== user.id) throw new Error('登录状态已变化，请重试。')
      for (const result of results) if (result.ids) result.provider.availableModels = result.ids
      const selected = user.providers.find(p => p.id === user.activeProviderId)
      if (selected && !selected.availableModels.includes(user.selectedModel || '')) user.selectedModel = selected.availableModels[0] || null
    })
    return { snapshot: this.store.snapshot(), errors: results.filter(r => r.error).map(r => r.error) }
  }

  /** 用准确的地址与密钥测试 /models，只有有效非空列表才加密保存服务，失败保持原配置。 */
  async testAndSave(input: ProviderDraft): Promise<Snapshot> {
    const user = this.store.requireUser()
    if (!input || typeof input !== 'object') throw new Error('服务配置无效。')
    const existing = input.id ? user.providers.find(p => p.id === input.id) : undefined
    if (input.id && !existing) throw new Error('服务配置不存在。')
    const name = textInput(input.name, 40)
    const baseUrl = validateBaseUrl(input.baseUrl)
    if (typeof input.apiKey !== 'string' || input.apiKey.length > 4096) throw new Error('API 密钥无效。')
    const apiKey = input.apiKey.trim() || (existing ? await this.secrets.decrypt(existing.encryptedApiKey) : '')
    if (!apiKey) throw new Error('请输入 API 密钥。')
    let availableModels: string[]
    try { availableModels = await listModels({ baseUrl, apiKey }) }
    catch (error) {
      const detail = error instanceof Error ? error.message.split(apiKey).join('[密钥]') : '服务连接失败。'
      throw new Error(`连通测试未通过：${detail}`)
    }
    const profile = { id: existing?.id || randomUUID(), name, baseUrl, availableModels, encryptedApiKey: await this.secrets.encrypt(apiKey) }
    this.store.transaction(() => {
      if (this.store.requireUser().id !== user.id) throw new Error('登录状态已变化，请重试。')
      if (existing) user.providers = user.providers.map(p => p.id === profile.id ? profile : p)
      else user.providers.push(profile)
      if (user.activeProviderId !== profile.id || !availableModels.includes(user.selectedModel || '')) user.selectedModel = availableModels[0]
      user.activeProviderId = profile.id
    })
    return this.store.snapshot()
  }
}
