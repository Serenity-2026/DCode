/** 共享 UTF-8/SSE 字节解码；适配器在自身协议结束时返回 true，断流则拒绝。 */
export async function consumeEvents(body: ReadableStream<Uint8Array>, onData: (data: string) => boolean, onActivity: () => void): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let complete = false
  const frame = (value: string): void => {
    const data = value.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (data) complete = onData(data)
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
      if (done) { if (!complete && buffer.trim()) frame(buffer); break }
    }
    if (!complete) throw new Error('连接中断，回复尚未完成。请重试。')
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** 协议 JSON 解析入口，仅返回对象，不把服务端错误正文或秘密暴露到界面。 */
export function parseEvent(data: string): Record<string, any> {
  try {
    const value = JSON.parse(data)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value
  } catch { throw new Error('模型返回了无法解析的数据，请重试。') }
}

/** 两种适配器共用完整工具参数校验，禁止用修复过的半截 JSON 执行。 */
export function parseToolArguments(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value as Record<string, unknown>
  } catch { throw new Error('模型工具参数不是完整 JSON 对象。') }
}
