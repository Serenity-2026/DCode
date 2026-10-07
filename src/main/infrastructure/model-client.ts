import type { ModelDetails, ReasoningEffort } from '../../shared/types'
import { reasoningEfforts } from '../../shared/context'
import type { ModelConfig, ProviderConfig } from '../domain/model-config'

/** 用账号服务的 URL 与密钥获取模型 ID、窗口和强度元数据，供 Models 保存验证与登录后刷新共用。 */
export async function listModels(config: ProviderConfig): Promise<{ ids: string[]; details: Record<string, ModelDetails> }> {
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

/** 模型单次增量的文本与推理内容，由 consumeSSE 解析后交给 Chat 追加到消息。 */
export interface Delta { content?: string; reasoning?: string }

/**
 * 消费模型响应的 SSE 字节流，用 TextDecoder 处理跨网络分块的 UTF-8 文本。
 * 通过 onDelta 交付内容增量、onActivity 通知连接活跃；缺少 [DONE] 或异常结束时抛错。
 * 不依赖 StateService/Chat，由 streamModel 调用，便于单独测试流协议。
 */
export async function consumeSSE(body: ReadableStream<Uint8Array>, onDelta: (delta: Delta) => void, onActivity: () => void = () => {}): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let complete = false
  let finish: string | null = null
  /** 解析一个完整 SSE 帧，跳过心跳，提取 Delta 或记录服务端的结束标记。 */
  const frame = (value: string): void => {
    const data = value.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (!data) return
    if (data.trim() === '[DONE]') { complete = true; return }
    let chunk: { error?: unknown; choices?: { delta?: { content?: string; reasoning_content?: string }; finish_reason?: string | null }[] }
    try { chunk = JSON.parse(data) } catch { throw new Error('模型返回了无法解析的数据，请重试。') }
    if (chunk.error) throw new Error('模型服务返回错误，请重试。')
    const choice = chunk.choices?.[0]
    if (choice?.delta) {
      onDelta({ content: choice.delta.content || '', reasoning: choice.delta.reasoning_content || '' })
    }
    if (choice?.finish_reason) finish = choice.finish_reason
  }
  try {
    while (!complete) {
      const { value, done } = await reader.read()
      if (value?.length) onActivity()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      buffer = buffer.replace(/\r\n/g, '\n')
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        frame(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        if (complete) break
      }
      if (done) {
        if (buffer.trim()) frame(buffer)
        break
      }
    }
    if (!complete) throw new Error('连接中断，回复尚未完成。请重试。')
    if (finish === 'length') throw new Error('回复达到长度上限，内容已保留。')
    if (finish === 'content_filter') throw new Error('回复被服务过滤，内容已保留。')
    if (finish && finish !== 'stop') throw new Error('模型未返回完整文本回复，请重试。')
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/**
 * 使用 ModelConfig 和 fetch 发起流式对话请求，由 consumeSSE 解析响应。
 * 依赖调用方传入的 AbortController 支持停止，并将 HTTP、网络和空闲超时转为可读错误；
 * 通过 onDelta 返回增量，不直接修改会话或操作界面。
 */
export async function streamModel(
  config: ModelConfig,
  messages: { role: string; content: string }[],
  controller: AbortController,
  onDelta: (delta: Delta) => void,
  options: { maxTokens?: number; timeoutMs?: number } = {}
): Promise<void> {
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
    // OpenAI 兼容服务可按 service_tier 请求快速模式；DeepSeek 不发送未声明支持的参数。
    const deepseek = new URL(config.baseUrl).hostname === 'api.deepseek.com'
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model, messages, stream: true, max_tokens: options.maxTokens || 8192,
        ...(deepseek && config.reasoningEffort ? { thinking: { type: 'enabled' } } : !deepseek && config.fastMode ? { service_tier: 'priority' } : {}),
        ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {})
      }),
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
    await consumeSSE(response.body, onDelta, resetTimeout)
  } catch (error) {
    if (timedOut) throw new Error('模型响应超时，请重试。')
    if (controller.signal.aborted) throw error
    if (error instanceof TypeError) throw new Error('无法连接模型服务，请检查网络后重试。')
    throw error
  } finally {
    clearTimeout(timer!)
  }
}
