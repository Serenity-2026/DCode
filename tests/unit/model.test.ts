import { afterEach, describe, expect, it, vi } from 'vitest'
import { consumeSSE, streamModel } from '../../src/main/model'

function bytes(text: string, step = 1): ReadableStream<Uint8Array> {
  const data = new TextEncoder().encode(text)
  return new ReadableStream({ start(controller) {
    for (let i = 0; i < data.length; i += step) controller.enqueue(data.slice(i, i + step))
    controller.close()
  } })
}
const config = { baseUrl: 'https://api.example.com', apiKey: 'test-secret', model: 'test' }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('SSE protocol and model requests', () => {
  it('decodes split UTF-8, CRLF, heartbeat, reasoning and completion', async () => {
    const chunks: string[] = []
    const reasoning: string[] = []
    await consumeSSE(bytes(': heartbeat\r\n\r\ndata: {"choices":[{"delta":{"reasoning_content":"思考"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"你好🙂"}}]}\r\n\r\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n'), delta => {
      chunks.push(delta.content || '')
      reasoning.push(delta.reasoning || '')
    })
    expect(chunks.join('')).toBe('你好🙂')
    expect(reasoning.join('')).toBe('思考')
  })

  it('rejects abnormal EOF even when partial content was received', async () => {
    await expect(consumeSSE(bytes('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'), () => {})).rejects.toThrow('连接中断')
  })

  it('reports truncated and malformed responses', async () => {
    await expect(consumeSSE(bytes('data: {"choices":[{"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'), () => {})).rejects.toThrow('长度上限')
    await expect(consumeSSE(bytes('data: invalid\n\n'), () => {})).rejects.toThrow('无法解析')
  })

  it.each([401, 402, 429, 503])('handles HTTP %s without exposing response secrets', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('test-secret', { status })))
    try {
      await streamModel(config, [], new AbortController(), () => {})
      expect.fail('must reject')
    } catch (error) {
      expect((error as Error).message).not.toContain('test-secret')
    }
  })

  it('sends a streaming request with credentials only in headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(bytes('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')))
    vi.stubGlobal('fetch', fetchMock)
    await streamModel(config, [{ role: 'user', content: 'hi' }], new AbortController(), () => {})
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.example.com/chat/completions')
    expect(options.headers.Authorization).toBe('Bearer test-secret')
    expect(JSON.parse(options.body)).toMatchObject({ stream: true, model: 'test' })
    expect(options.body).not.toContain('test-secret')
  })

  it('limits the DeepSeek thinking parameter to the official service', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(bytes('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')))
    vi.stubGlobal('fetch', fetchMock)
    for (const baseUrl of ['https://api.deepseek.com', 'https://compatible.example.com/v1']) {
      await streamModel({ ...config, baseUrl }, [], new AbortController(), () => {})
    }
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).thinking).toEqual({ type: 'disabled' })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty('thinking')
  })

  it('sends priority only with fast mode on and avoids unsupported DeepSeek fields', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(bytes('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')))
    vi.stubGlobal('fetch', fetchMock)
    await streamModel({ ...config, fastMode: true }, [], new AbortController(), () => {})
    await streamModel({ ...config, fastMode: false }, [], new AbortController(), () => {})
    await streamModel({ ...config, baseUrl: 'https://api.deepseek.com', fastMode: true }, [], new AbortController(), () => {})
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).service_tier).toBe('priority')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty('service_tier')
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).not.toHaveProperty('service_tier')
  })

  it('sends selected reasoning effort, enables DeepSeek thinking and omits automatic effort', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(bytes('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')))
    vi.stubGlobal('fetch', fetchMock)
    await streamModel({ ...config, reasoningEffort: 'medium' }, [], new AbortController(), () => {})
    await streamModel({ ...config, baseUrl: 'https://api.deepseek.com', reasoningEffort: 'max' }, [], new AbortController(), () => {})
    await streamModel({ ...config, reasoningEffort: null }, [], new AbortController(), () => {})
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ reasoning_effort: 'medium' })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ reasoning_effort: 'max', thinking: { type: 'enabled' } })
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).not.toHaveProperty('reasoning_effort')
  })

  it('aborts idle connections on timeout', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })))
    const promise = streamModel(config, [], new AbortController(), () => {})
    const assertion = expect(promise).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(60_000)
    await assertion
  })

  it('keeps an active connection alive while the provider sends heartbeats', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(stream) {
      const encoder = new TextEncoder()
      const heartbeat = setInterval(() => stream.enqueue(encoder.encode(': heartbeat\n\n')), 30_000)
      setTimeout(() => {
        clearInterval(heartbeat)
        stream.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'))
        stream.close()
      }, 90_000)
    } }))))
    const promise = streamModel(config, [], controller, () => {})
    const assertion = expect(promise).resolves.toBeUndefined()
    await vi.advanceTimersByTimeAsync(90_000)
    await assertion
    expect(controller.signal.aborted).toBe(false)
  })
})
