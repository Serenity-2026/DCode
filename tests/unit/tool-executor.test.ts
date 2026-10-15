import { expect, it, vi } from 'vitest'
import type { AgentLoopEvent, RegisteredTool } from '../../src/main/domain/agent'
import { ToolExecutionError, type AgentTool, type AgentToolResult, type LlmContent, type ToolExecutionMode } from '../../src/main/domain/llm'
import { toolValidator } from '../../src/main/infrastructure/tool-schema'
import { ToolExecutor } from '../../src/main/services/tool-executor'

/** 用明确的开始/结束信号验证调度，不依赖固定等待时间。 */
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

function result(text: string): AgentToolResult { return { content: [{ type: 'text', text }], details: undefined } }
function call(id: string, name = id): Extract<LlmContent, { type: 'toolCall' }> { return { type: 'toolCall', id, name, arguments: { text: id } } }
function registered(name: string, executionMode?: ToolExecutionMode, execute: AgentTool['execute'] = async () => result(name)): RegisteredTool {
  const tool: AgentTool = { name, description: '测试工具', executionMode, parameters: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } }, execute }
  return { tool, validate: toolValidator(tool) }
}

it('runs contiguous parallel groups with serial barriers and records results in source order', async () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f']
  const starts: string[] = []
  const events: AgentLoopEvent[] = []
  const entered = Object.fromEntries(names.map(name => [name, gate()]))
  const finished = Object.fromEntries(names.map(name => [name, gate()]))
  const ended = Object.fromEntries(names.map(name => [name, gate()]))
  const tools = names.map(name => registered(name, ['c', 'f'].includes(name) ? 'sequential' : 'parallel', async () => {
    starts.push(name); entered[name].release()
    await finished[name].promise
    return result(name)
  }))
  const pending = new ToolExecutor().execute(names.map(name => call(name)), tools, new AbortController().signal, event => {
    events.push(event)
    if (event.type === 'tool_execution_end') ended[event.toolCallId].release()
  })
  await Promise.all([entered.a.promise, entered.b.promise])
  expect(starts).toEqual(['a', 'b'])
  finished.b.release(); await ended.b.promise
  expect(starts).toEqual(['a', 'b'])
  expect(events.filter(event => event.type === 'message_end')).toEqual([])
  finished.a.release(); await entered.c.promise
  expect(starts).toEqual(['a', 'b', 'c'])
  finished.c.release(); await Promise.all([entered.d.promise, entered.e.promise])
  expect(starts).toEqual(['a', 'b', 'c', 'd', 'e'])
  finished.e.release(); await ended.e.promise
  expect(starts).not.toContain('f')
  finished.d.release(); await entered.f.promise
  finished.f.release()
  expect((await pending).map(message => message.toolCallId)).toEqual(names)
  expect(events.flatMap(event => event.type === 'tool_execution_end' ? [event.toolCallId] : [])).toEqual(['b', 'a', 'c', 'e', 'd', 'f'])
  expect(events.some(event => event.type === 'message_end')).toBe(false)
})

it('defaults undeclared tools to serial and keeps consecutive serial calls separate', async () => {
  const first = gate()
  const second = gate()
  const entered = gate()
  const starts: string[] = []
  const tools = [
    registered('a', undefined, async () => { starts.push('a'); await first.promise; return result('a') }),
    registered('b', 'sequential', async () => { starts.push('b'); entered.release(); await second.promise; return result('b') }),
    registered('c', 'parallel', async () => { starts.push('c'); return result('c') })
  ]
  const pending = new ToolExecutor().execute(tools.map(item => call(item.tool.name)), tools, new AbortController().signal, () => {})
  expect(starts).toEqual([])
  first.release(); await entered.promise
  expect(starts).toEqual(['a', 'b'])
  second.release(); await pending
  expect(starts).toEqual(['a', 'b', 'c'])
})

it('converts invalid and failed calls into results and continues through later groups', async () => {
  const invalid = vi.fn(async () => result('不应执行'))
  const tools = [
    registered('unexpected', 'parallel', async () => { throw new Error('执行故障') }),
    registered('public', 'parallel', async () => { throw new ToolExecutionError('可公开错误') }),
    registered('bad', 'parallel', async () => ({ content: 'not-blocks' } as unknown as AgentToolResult)),
    registered('invalid', 'parallel', invalid),
    registered('last', 'parallel', async () => ({ ...result('失败输出'), isError: true, details: { exitCode: 7 }, structuredContent: [1, null] }))
  ]
  const calls = [call('unexpected'), call('public'), call('bad'), { ...call('invalid'), arguments: { text: 1 } }, call('unknown'), call('last')]
  const outputs = await new ToolExecutor().execute(calls, tools, new AbortController().signal, () => {})
  expect(outputs.map(output => output.isError)).toEqual([true, true, true, true, true, true])
  expect(outputs.map(output => output.content)).toEqual(['工具调用异常：执行故障', '可公开错误', '工具调用异常：工具结果无效。', '工具参数不符合 JSON Schema。', '工具未注册。', '失败输出'].map(text => [{ type: 'text', text }]))
  expect(outputs.at(-1)).toMatchObject({ details: { exitCode: 7 }, structuredContent: [1, null] })
  expect(invalid).not.toHaveBeenCalled()
})

it.each([new Error('校验器故障'), '校验器故障'])('returns validation exceptions as paired error results and continues (%s)', async cause => {
  const broken = registered('broken', 'parallel')
  broken.validate = () => { throw cause }
  const events: AgentLoopEvent[] = []
  const tools = [broken, registered('sibling', 'parallel'), registered('later', 'sequential')]
  const outputs = await new ToolExecutor().execute(tools.map(item => call(item.tool.name)), tools, new AbortController().signal, event => events.push(event))
  expect(outputs.map(output => output.toolCallId)).toEqual(['broken', 'sibling', 'later'])
  expect(outputs[0]).toMatchObject({ role: 'toolResult', toolCallId: 'broken', isError: true, content: [{ type: 'text', text: '工具调用异常：校验器故障' }] })
  expect(events.filter(event => event.type === 'tool_execution_start')).toHaveLength(3)
  expect(events.filter(event => event.type === 'tool_execution_end')).toHaveLength(3)
  expect(events.some(event => event.type === 'message_end')).toBe(false)
})

it('retains completed results on parallel cancellation and never starts later groups or emits late completion', async () => {
  const controller = new AbortController()
  const started = gate()
  const completed = gate()
  const late = gate()
  const events: AgentLoopEvent[] = []
  const next = vi.fn(async () => result('next'))
  const tools = [
    registered('done', 'parallel'),
    registered('waiting', 'parallel', async () => { started.release(); await late.promise; return result('late') }),
    registered('barrier', 'sequential', next),
    registered('later', 'parallel', next)
  ]
  const pending = new ToolExecutor().execute(tools.map(item => call(item.tool.name)), tools, controller.signal, event => {
    events.push(event)
    if (event.type === 'tool_execution_end' && event.toolCallId === 'done') completed.release()
  })
  const rejected = expect(pending).rejects.toThrow()
  await Promise.all([started.promise, completed.promise])
  controller.abort(); await rejected
  expect(next).not.toHaveBeenCalled()
  expect(events.flatMap(event => event.type === 'tool_execution_end' ? [event.toolCallId] : [])).toEqual(['done'])
  const count = events.length
  late.release(); await late.promise
  expect(events).toHaveLength(count)
})

it.each(['tool_execution_start', 'tool_execution_end'])('settles started siblings before propagating an observer failure at %s and skips later groups', async eventType => {
  const started = gate()
  const fault = gate()
  const sibling = gate()
  const next = vi.fn(async () => result('next'))
  const tools = [registered('a', 'parallel'), registered('b', 'parallel', async () => { started.release(); await sibling.promise; return result('b') }), registered('next', 'sequential', next)]
  let settled = false
  const pending = new ToolExecutor().execute(tools.map(item => call(item.tool.name)), tools, new AbortController().signal, event => {
    if (event.type === eventType && event.toolCallId === 'a') { fault.release(); throw new Error('事件订阅失败') }
  })
  void pending.then(() => { settled = true }, () => { settled = true })
  const rejected = expect(pending).rejects.toThrow('事件订阅失败')
  await Promise.all([started.promise, fault.promise])
  expect(settled).toBe(false)
  sibling.release(); await rejected
  expect(next).not.toHaveBeenCalled()
})

it('isolates simultaneous batches on one executor and isolates emitted result copies', async () => {
  const executor = new ToolExecutor()
  const waiting = gate()
  const started = gate()
  const first = executor.execute([call('same')], [registered('same', 'sequential', async () => { started.release(); await waiting.promise; return result('first') })], new AbortController().signal, () => {})
  await started.promise
  const second = await executor.execute([call('same')], [registered('same', 'parallel', async () => result('second'))], new AbortController().signal, event => {
    if (event.type === 'tool_execution_end') event.result.content = [{ type: 'text', text: 'mutated' }]
  })
  expect(second[0].content).toEqual([{ type: 'text', text: 'second' }])
  waiting.release()
  expect((await first)[0].content).toEqual([{ type: 'text', text: 'first' }])
})

it('rejects duplicate IDs and an already aborted batch before executing any tool', async () => {
  const execute = vi.fn(async () => result('never'))
  const emit = vi.fn()
  const tools = [registered('a', 'parallel', execute)]
  const executor = new ToolExecutor()
  await expect(executor.execute([call('same', 'a'), call('same', 'a')], tools, new AbortController().signal, emit)).rejects.toThrow('重复')
  const controller = new AbortController(); controller.abort()
  await expect(executor.execute([call('a')], tools, controller.signal, emit)).rejects.toThrow()
  expect(execute).not.toHaveBeenCalled()
  expect(emit).not.toHaveBeenCalled()
})
