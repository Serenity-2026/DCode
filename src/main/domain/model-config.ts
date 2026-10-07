import type { ModelApi, ReasoningEffort } from '../../shared/types'

/** 主进程服务凭据，由 loadConfig/Models 读取；密钥不传入 renderer。 */
export interface ProviderConfig {
  baseUrl: string
  apiKey: string
  api?: ModelApi
}

/** Chat 从账号的服务、列表选择及快速模式组装单次请求，Models 不固定模型 ID。 */
export interface ModelConfig extends ProviderConfig {
  model: string
  fastMode?: boolean
  reasoningEffort?: ReasoningEffort | null
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
