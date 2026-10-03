import { config } from 'dotenv'
import { join } from 'node:path'

export interface ModelConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export function loadConfig(userData: string, packaged: boolean): ModelConfig {
  config({ path: join(packaged ? userData : process.cwd(), '.env.local'), quiet: true })
  const baseUrl = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').trim().replace(/\/+$/, '')
  const url = new URL(baseUrl)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) {
    throw new Error('模型服务地址必须使用 HTTPS。')
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('模型服务地址格式不正确。')
  return {
    baseUrl,
    apiKey: process.env.DEEPSEEK_API_KEY?.trim() || '',
    model: process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash'
  }
}
