import { config } from 'dotenv'
import { join } from 'node:path'
import { validateBaseUrl, type ProviderConfig } from '../domain/model-config'

/** 通过 dotenv 读取通用 BASE_URL/API_KEY，不预设服务；Models 仅向首个注册账号导入完整配置。 */
export function loadConfig(userData: string, packaged: boolean): ProviderConfig {
  config({ path: join(packaged ? userData : process.cwd(), '.env.local'), quiet: true })
  const baseUrl = process.env.BASE_URL?.trim() || ''
  return {
    baseUrl: baseUrl ? validateBaseUrl(baseUrl) : '',
    apiKey: process.env.API_KEY?.trim() || ''
  }
}
