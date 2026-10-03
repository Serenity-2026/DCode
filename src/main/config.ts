import { config } from 'dotenv'
import { join } from 'node:path'

/** 主进程专用的模型连接配置；Chat/streamModel 使用密钥，Store.snapshot 只提取可公开字段。 */
export interface ModelConfig {
  baseUrl: string
  apiKey: string
  model: string
}

/**
 * 使用 dotenv 加载本地环境文件，再从 process.env 读取并校验 ModelConfig。
 * 开发时读取项目根目录，打包后读取 Electron userData；系统已有环境变量优先。
 * 由主进程启动入口调用，配置中的密钥不经 preload 暴露给界面。
 */
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
