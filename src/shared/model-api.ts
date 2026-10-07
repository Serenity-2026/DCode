import type { ModelApi } from './types'

/** 服务协议白名单，设置、持久化校验与主进程请求选择共用。 */
export const modelApis: ModelApi[] = ['openai-completions', 'anthropic-messages']

/** 显式配置优先；旧配置只识别官方 Anthropic 地址，其余保持 OpenAI 兼容行为。 */
export function resolveModelApi(baseUrl: string, api?: ModelApi): ModelApi {
  if (api !== undefined) {
    if (!modelApis.includes(api)) throw new Error('模型 API 协议无效。')
    return api
  }
  return baseUrl && new URL(baseUrl).hostname === 'api.anthropic.com' ? 'anthropic-messages' : 'openai-completions'
}
