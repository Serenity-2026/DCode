import { config } from 'dotenv'
import { join } from 'node:path'

/** 主进程专用的模型连接配置；Chat/streamModel 使用密钥，Store.snapshot 只提取可公开字段。 */
export interface ModelConfig {
  baseUrl: string
  apiKey: string
  model: string
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

/** 读取启动环境配置，仅供 Models 向首个注册账号导入；之后以账号自己的配置为准。 */
export function loadConfig(userData: string, packaged: boolean): ModelConfig {
  config({ path: join(packaged ? userData : process.cwd(), '.env.local'), quiet: true })
  const baseUrl = validateBaseUrl(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com')
  return {
    baseUrl,
    apiKey: process.env.DEEPSEEK_API_KEY?.trim() || '',
    model: process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash'
  }
}
