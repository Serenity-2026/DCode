import { randomUUID } from 'node:crypto'
import type { ModelDraft, Snapshot } from '../shared/types'
import { validateBaseUrl, type ModelConfig } from './config'
import { streamModel } from './model'
import type { SecretCodec } from './secrets'
import { Store, textInput, type StoredUser } from './store'

/** 管理账号下的模型配置，依赖 Store 检查归属、Secrets 加密密钥、streamModel 实测连通性。 */
export class Models {
  /** 环境配置只作为首个注册账号的导入来源，不作为其他账号的共享默认密钥。 */
  constructor(private store: Store, private secrets: SecretCodec, private initial: ModelConfig) {}

  /** 将已存在的环境配置加密导入首个账号，由 Auth.register 在首次注册时调用。 */
  async bootstrap(): Promise<StoredUser['models'][number] | null> {
    if (!this.initial.apiKey) return null
    return { id: randomUUID(), name: '环境默认', baseUrl: this.initial.baseUrl, model: this.initial.model, encryptedApiKey: await this.secrets.encrypt(this.initial.apiKey) }
  }

  /** 解密当前账号选中的模型，供主进程传给 Chat；模型密钥不回传界面。 */
  async selected(): Promise<ModelConfig> {
    const user = this.store.requireUser()
    const model = user.models.find(m => m.id === user.activeModelId)
    if (!model) throw new Error('请先添加模型配置。')
    return { baseUrl: model.baseUrl, model: model.model, apiKey: await this.secrets.decrypt(model.encryptedApiKey) }
  }

  /** 实测正在提交的配置，成功才加密保存并选中；错误与超时不会覆盖原配置。 */
  async testAndSave(input: ModelDraft): Promise<Snapshot> {
    const user = this.store.requireUser()
    if (!input || typeof input !== 'object') throw new Error('模型配置无效。')
    const existing = input.id ? user.models.find(m => m.id === input.id) : undefined
    if (input.id && !existing) throw new Error('模型配置不存在。')
    const name = textInput(input.name, 40)
    const baseUrl = validateBaseUrl(input.baseUrl)
    const model = textInput(input.model, 120)
    if (typeof input.apiKey !== 'string' || input.apiKey.length > 4096) throw new Error('API 密钥无效。')
    const apiKey = input.apiKey.trim() || (existing ? await this.secrets.decrypt(existing.encryptedApiKey) : '')
    if (!apiKey) throw new Error('请输入 API 密钥。')
    let content = ''
    const controller = new AbortController()
    // 测试总时长也限制为 15 秒，避免服务持续发心跳却永不结束时锁住配置编辑。
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      await streamModel({ baseUrl, model, apiKey }, [{ role: 'user', content: 'Reply with OK.' }], controller, delta => { content += delta.content || '' }, { maxTokens: 16, timeoutMs: 15_000 })
      if (!content.trim()) throw new Error('模型没有返回文本。')
    } catch (error) {
      // 兼容服务可能在异常体中回显请求内容，提示中不允许出现正在测试的密钥。
      const detail = controller.signal.aborted ? '模型响应超时，请重试。' : error instanceof Error ? error.message.split(apiKey).join('[密钥]') : '服务连接失败。'
      throw new Error(`连通测试未通过：${detail}`)
    } finally { clearTimeout(timeout) }
    const profile = { id: existing?.id || randomUUID(), name, baseUrl, model, encryptedApiKey: await this.secrets.encrypt(apiKey) }
    this.store.transaction(() => {
      if (this.store.requireUser().id !== user.id) throw new Error('登录状态已变化，请重试。')
      if (existing) user.models = user.models.map(m => m.id === profile.id ? profile : m)
      else user.models.push(profile)
      user.activeModelId = profile.id
    })
    return this.store.snapshot()
  }
}
