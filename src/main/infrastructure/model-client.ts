import type { ModelDetails, ReasoningEffort } from '../../shared/types'
import { reasoningEfforts } from '../../shared/context'
import type { ModelConfig, ProviderConfig } from '../domain/model-config'
import type { AssistantMessage, LlmDelta, LlmMessage, ToolDefinition } from '../domain/llm'
import { resolveModelApi } from '../../shared/model-api'
import { consumeSSE, openAIRequest } from './llm/openai'
import { consumeAnthropic, anthropicRequest } from './llm/anthropic'

/** 两种协议共用服务地址与认证规则；Anthropic 接受官方根地址或带 /v1 的 API 地址。 */
function providerTransport(config: ProviderConfig): { baseUrl: string; headers: Record<string, string> } {
  return resolveModelApi(config.baseUrl, config.api) === 'anthropic-messages'
    ? { baseUrl: `${config.baseUrl.replace(/\/v1$/, '')}/v1`, headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' } }
    : { baseUrl: config.baseUrl, headers: { Authorization: `Bearer ${config.apiKey}` } }
}

/** 用账号服务的 URL 与密钥获取模型 ID、窗口和强度元数据，供 Models 保存验证与登录后刷新共用。 */
export async function listModels(config: ProviderConfig): Promise<{ ids: string[]; details: Record<string, ModelDetails> }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    const api = resolveModelApi(config.baseUrl, config.api)
    const transport = providerTransport(config)
    const data: Record<string, any>[] = []
    const cursors = new Set<string>()
    let cursor = ''
    do {
      const response = await fetch(`${transport.baseUrl}/models${cursor ? `?after_id=${encodeURIComponent(cursor)}` : ''}`, {
        headers: { ...transport.headers, Accept: 'application/json' }, redirect: 'error', signal: controller.signal
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(response.status === 401 || response.status === 403 ? 'API 密钥无效或无权获取模型列表。' : response.status === 404 ? '服务的模型列表接口不存在，请检查服务地址。' : `获取模型列表失败（${response.status}）。`)
      }
      const payload = await response.json()
      if (!payload || !Array.isArray(payload.data) || payload.data.some((item: { id?: unknown }) => !item || typeof item.id !== 'string' || !item.id.trim())) throw new Error('服务返回的模型列表格式不正确。')
      data.push(...payload.data)
      cursor = ''
      if (api === 'anthropic-messages' && payload.has_more === true) {
        if (!payload.data.length || typeof payload.last_id !== 'string' || !payload.last_id || cursors.has(payload.last_id)) throw new Error('服务返回的模型分页格式不正确。')
        cursor = payload.last_id
        cursors.add(cursor)
      }
    } while (cursor)
    const ids = [...new Set<string>(data.map(item => item.id))]
    if (!ids.length) throw new Error('该服务没有返回可用模型。')
    const details = Object.fromEntries(data.map(item => {
      const detail: ModelDetails = {}
      const window = [item.context_window, item.context_length, item.top_provider?.context_length].find(value => Number.isSafeInteger(value) && value > 0)
      if (window !== undefined) detail.contextWindow = window
      if (Array.isArray(item.effort?.supported_levels)) detail.reasoningEfforts = [...new Set<ReasoningEffort>(item.effort.supported_levels.filter((level: unknown) => reasoningEfforts.includes(level as ReasoningEffort)))]
      if (detail.reasoningEfforts?.includes(item.effort?.default_level)) detail.defaultEffort = item.effort.default_level
      return [item.id, detail]
    }))
    return { ids, details }
  } catch (error) {
    if (controller.signal.aborted) throw new Error('获取模型列表超时，请重试。')
    if (error instanceof TypeError) throw new Error('无法连接模型服务，请检查网络和服务地址。')
    if (error instanceof SyntaxError) throw new Error('服务返回的模型列表格式不正确。')
    throw error
  } finally { clearTimeout(timeout) }
}

/**
 * 使用 ModelConfig 和 fetch 发起流式对话请求，由 consumeSSE 解析响应。
 * 依赖调用方传入的 AbortController 支持停止，并将 HTTP、网络和空闲超时转为可读错误；
 * 通过 onDelta 返回增量，不直接修改会话或操作界面。
 */
export async function streamModel(
  config: ModelConfig,
  messages: LlmMessage[],
  controller: AbortController,
  onDelta: (delta: LlmDelta) => void,
  options: { maxTokens?: number; timeoutMs?: number; tools?: ToolDefinition[] } = {}
): Promise<AssistantMessage> {
  controller.signal.throwIfAborted()
  if (!config.apiKey) throw new Error('请先在设置中填写 API 密钥。')
  let timedOut = false
  let timer: ReturnType<typeof setTimeout>
  /** 每次收到字节（包括心跳）刷新空闲计时；聊天默认 60 秒，Models 测试使用 15 秒。 */
  const resetTimeout = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => { timedOut = true; controller.abort() }, options.timeoutMs || 60_000)
  }
  resetTimeout()
  try {
    const api = resolveModelApi(config.baseUrl, config.api)
    const transport = providerTransport(config)
    const deepseek = new URL(config.baseUrl).hostname === 'api.deepseek.com'
    const tools = options.tools || []
    const request = api === 'anthropic-messages' ? anthropicRequest : openAIRequest
    const response = await fetch(`${transport.baseUrl}/${api === 'anthropic-messages' ? 'messages' : 'chat/completions'}`, {
      method: 'POST', redirect: 'error',
      headers: { ...transport.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(request(config, messages, tools, options.maxTokens || 8192)),
      signal: controller.signal
    })
    if (!response.ok) {
      const errors: Record<number, string> = {
        400: config.reasoningEffort ? '请求参数或模型强度不受支持，请调整强度并检查模型配置。' : config.fastMode && !deepseek ? '请求参数或快速模式不受支持，请关闭快速模式并检查模型配置。' : '请求参数或模型不受支持，请检查模型配置。',
        401: 'API 密钥无效，请检查模型配置。',
        402: '模型账户余额不足，请充值后重试。',
        403: '无权访问该模型，请检查账户权限。',
        404: '模型服务地址或模型不存在。',
        429: '请求过于频繁，请稍后重试。'
      }
      await response.body?.cancel()
      throw new Error(errors[response.status] || `模型服务暂不可用（${response.status}），请稍后重试。`)
    }
    if (!response.body) throw new Error('模型服务没有返回响应内容。')
    const consume = api === 'anthropic-messages' ? consumeAnthropic : consumeSSE
    const reply = await consume(response.body, onDelta, resetTimeout)
    reply.source = { api, baseUrl: config.baseUrl, model: config.model }
    return reply
  } catch (error) {
    if (timedOut) throw new Error('模型响应超时，请重试。')
    if (controller.signal.aborted) throw error
    if (error instanceof TypeError) throw new Error('无法连接模型服务，请检查网络后重试。')
    throw error
  } finally {
    clearTimeout(timer!)
  }
}
