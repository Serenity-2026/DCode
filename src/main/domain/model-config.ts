import type { ModelApi, ReasoningEffort } from '../../shared/types'

/** 主进程服务凭据，由 loadConfig/Models 读取；密钥不传入 renderer。 */
export interface ProviderConfig {
  baseUrl: string
  apiKey: string
  api?: ModelApi
}

/** AgentSession 从账号的服务、列表选择及快速模式组装单次请求，Models 不固定模型 ID。 */
export interface ModelConfig extends ProviderConfig {
  model: string
  fastMode?: boolean
  reasoningEffort?: ReasoningEffort | null
}

/** 手动模型 ID 只校验格式，不推断供应商支持情况或模型能力。 */
export function validateManualModels(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 100 || value.some(id => typeof id !== 'string' || !id.trim() || id.trim().length > 256 || /\s|[\x00-\x1f\x7f]/.test(id.trim()))) throw new Error('模型 ID 必须为 1–256 个非空白字符，最多添加 100 个。')
  return [...new Set(value.map(id => id.trim()))]
}

/** 校验并规范化模型服务地址，供环境导入与用户填写的配置共用，不允许携带认证或查询信息。 */
export function validateBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('模型服务地址格式不正确。')
  const baseUrl = value.trim().replace(/\/+$/, '')
  let url: URL
  try { url = new URL(baseUrl) } catch { throw new Error('模型服务地址格式不正确。') }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) {
    throw new Error('模型服务地址必须使用 HTTPS。')
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('模型服务地址格式不正确。')
  return baseUrl
}
