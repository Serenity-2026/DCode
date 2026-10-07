import { afterEach, expect, it, vi } from 'vitest'
import { ToolRegistry } from '../../src/main/services/tool-registry'
import { agentLimits, type AgentTool } from '../../src/main/domain/agent'

const definition = { name: 'echo', description: '回传文本', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }
const call = { id: 'call_1', name: 'echo', arguments: '{"text":"你好"}' }
afterEach(() => vi.useRealTimers())

it('compiles definitions once, rejects duplicates and protects the registered schema', () => {
  const tool: AgentTool = { definition, execute: async () => '' }
  expect(() => new ToolRegistry([tool, tool])).toThrow('重复')
  expect(() => new ToolRegistry([{ ...tool, definition: { ...definition, parameters: { type: 'string' } } }])).toThrow('object')
  expect(() => new ToolRegistry([{ ...tool, definition: { ...definition, parameters: { type: 'object', misspelled: true } } }])).toThrow()
  const registry = new ToolRegistry([tool])
  registry.definitions()[0].name = 'changed'
  expect(registry.definitions()[0].name).toBe('echo')
})

it.each(['invalid', 'null', '[]', '{}', '{"text":123}', '{"text":"ok","extra":true}'])('never executes invalid parameters: %s', async argumentsText => {
  const execute = vi.fn(async () => 'should not run')
  const registry = new ToolRegistry([{ definition, execute }])
  expect((await registry.execute({ ...call, arguments: argumentsText }, new AbortController().signal)).ok).toBe(false)
  expect(execute).not.toHaveBeenCalled()
})

it('blocks unknown names and oversized arguments before executing a handler', async () => {
  const execute = vi.fn(async () => '')
  const registry = new ToolRegistry([{ definition, execute }])
  await expect(registry.execute({ ...call, name: 'shell' }, new AbortController().signal)).resolves.toMatchObject({ ok: false })
  await expect(registry.execute({ ...call, arguments: 'x'.repeat(agentLimits.maxArgumentBytes + 1) }, new AbortController().signal)).resolves.toMatchObject({ ok: false })
  expect(execute).not.toHaveBeenCalled()
})

it('returns validated results, limits output and sanitizes handler exceptions', async () => {
  const execute = vi.fn().mockResolvedValueOnce('你好').mockResolvedValueOnce('中'.repeat(agentLimits.maxResultBytes)).mockRejectedValueOnce(new Error('private-key /local/path'))
  const registry = new ToolRegistry([{ definition, execute }])
  const signal = new AbortController().signal
  await expect(registry.execute(call, signal)).resolves.toEqual({ ok: true, content: '你好' })
  expect(execute.mock.calls[0][0]).toEqual({ text: '你好' })
  await expect(registry.execute(call, signal)).resolves.toMatchObject({ ok: false, content: expect.stringContaining('大小上限') })
  await expect(registry.execute(call, signal)).resolves.toEqual({ ok: false, content: '工具执行失败。' })
})

it('times out non-cooperative tools and cleans its timer', async () => {
  vi.useFakeTimers()
  let handlerSignal!: AbortSignal
  const registry = new ToolRegistry([{ definition, execute: async (_input, context) => { handlerSignal = context.signal; return new Promise(() => {}) } }], 10)
  const result = registry.execute(call, new AbortController().signal)
  const assertion = expect(result).resolves.toEqual({ ok: false, content: '工具执行超时。' })
  await vi.advanceTimersByTimeAsync(10)
  await assertion
  expect(handlerSignal.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('cancels waiting tools and rejects already-cancelled calls without executing', async () => {
  const execute = vi.fn(async () => new Promise<string>(() => {}))
  const registry = new ToolRegistry([{ definition, execute }])
  const controller = new AbortController()
  const pending = registry.execute(call, controller.signal)
  const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await assertion
  await expect(registry.execute(call, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(execute).not.toHaveBeenCalled()
})
