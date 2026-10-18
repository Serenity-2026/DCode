import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { isUsageRecord, localDay, shiftDay, summarizeUsage, usageCalendar, type UsageRecord } from '../../src/shared/usage'
import { consumeSSE, openAIRequest } from '../../src/main/infrastructure/llm/openai'
import { consumeAnthropic } from '../../src/main/infrastructure/llm/anthropic'
import { AgentSession } from '../../src/main/agent/agent-session'
import { StateService } from '../../src/main/services/state-service'
import { StateRepository } from '../../src/main/repositories/state-repository'
import { Agent } from '../../src/main/agent/agent'
import { AgentLoop } from '../../src/main/agent/agent-loop'
import { create, cleanup, config, unexpectedTaskError } from './helpers'
import { anthropicEvents, eventBytes, echoTool } from './llm-fixtures'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); cleanup() })
const record = (days: Record<string, number>): UsageRecord => ({ id: 'task', startedAt: '2026-01-01T00:00:00Z', lastActiveAt: '2026-01-01T00:01:00Z', finishedAt: '2026-01-01T00:01:00Z', requests: 1, reportedRequests: 1, days, tools: [] })

it('requests streaming usage and accepts an OpenAI usage-only chunk without double counting detail categories', async () => {
  expect(openAIRequest(config, [], [], 100)).toMatchObject({ stream_options: { include_usage: true } })
  const usage: number[] = []
  await consumeSSE(eventBytes([
    { choices: [{ delta: { content: '回答' }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 3 } } },
    { choices: [], usage: { total_tokens: -1 } },
    { choices: [], usage: { total_tokens: '30' } }
  ], 'data: [DONE]\n\n'), delta => { if (delta.totalTokens !== undefined) usage.push(delta.totalTokens) })
  expect(usage).toEqual([30])
})

it('merges Anthropic cumulative usage and includes cache tokens exactly once', async () => {
  const events = anthropicEvents('正文')
  events[0] = { type: 'message_start', message: { role: 'assistant', usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } }
  events.splice(-2, 0, { type: 'message_delta', usage: { output_tokens: 5 } })
  events[events.length - 2] = { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12, input_tokens: null, cache_creation_input_tokens: null } }
  const usage: number[] = []
  await consumeAnthropic(eventBytes(events), delta => { if (delta.totalTokens !== undefined) usage.push(delta.totalTokens) })
  expect(usage).toEqual([16, 20, 27])
})

it('aggregates daily totals, daily peak, task duration, streaks and ranked tools', () => {
  const a = record({ '2026-02-27': 10, '2026-02-28': 20, '2026-03-01': 30 })
  a.tools = [{ kind: 'mcp', name: 'docs', count: 2 }, { kind: 'skill', name: 'review', count: 1 }]
  const b = { ...record({ '2026-03-01': 10, '2026-03-04': 5 }), id: 'second', requests: 2, reportedRequests: 1, tools: [{ kind: 'mcp' as const, name: 'docs', count: 1 }] }
  const stats = summarizeUsage([a, b], '2026-03-05')
  expect(stats).toMatchObject({ totalTokens: 75, peakTokens: 40, longestTaskMs: 60_000, longestStreak: 3, currentStreak: 1, missingRequests: 1 })
  expect(stats.tools).toEqual([{ kind: 'mcp', name: 'docs', count: 3 }, { kind: 'skill', name: 'review', count: 1 }])
  expect(summarizeUsage([a, b], '2026-03-06').currentStreak).toBe(0)
  expect(summarizeUsage([], '2026-03-05')).toMatchObject({ totalTokens: 0, longestStreak: 0, currentStreak: 0 })
})

it('lays out 53 local calendar weeks, including leap days and all-time cumulative totals', () => {
  expect(shiftDay('2024-02-28', 1)).toBe('2024-02-29')
  expect(shiftDay('2024-12-31', 1)).toBe('2025-01-01')
  expect(shiftDay('2026-03-08', 1)).toBe('2026-03-09')
  const weeks = usageCalendar(new Map([['2020-01-01', 100], ['2026-03-01', 10], ['2026-03-02', 20]]), '2026-03-02')
  expect(weeks).toHaveLength(53)
  expect(weeks.at(-1)).toMatchObject({ start: '2026-03-02', end: '2026-03-02', tokens: 20 })
  expect(weeks.at(-1)!.dates[0]).toMatchObject({ cumulative: 130, future: false })
  expect(weeks.at(-1)!.dates.slice(1).every(day => day.future)).toBe(true)
})

it('records cumulative snapshots once per model request, counts trusted tool identities and survives retry/deletion/restart', async () => {
  const { store, path, auth } = await create()
  let round = 0
  const agent = new Agent(new AgentLoop(async (_config, _messages, _controller, delta) => {
    delta({ totalTokens: 10 }); delta({ totalTokens: 10 }); delta({ totalTokens: 30 })
    if (round++ === 0) return { role: 'assistant', stopReason: 'toolCall', content: [{ type: 'toolCall', id: 'one', name: 'echo', arguments: { text: '测试' } }, { type: 'toolCall', id: 'two', name: 'review', arguments: { text: '审查' } }, { type: 'toolCall', id: 'three', name: 'mcp_fake', arguments: {} }, { type: 'toolCall', id: 'four', name: 'echo', arguments: {} }] }
    delta({ content: '完成' })
    return { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '完成' }] }
  }), [{ ...echoTool, usageIdentity: { kind: 'mcp', name: '文档检索' } }, { ...echoTool, name: 'review', usageIdentity: { kind: 'skill', name: '代码审查' } }])
  const session = new AgentSession(store, () => {}, agent, unexpectedTaskError)
  session.send({ content: '测试' }, config)
  await agent.waitForIdle()
  expect(store.snapshot().usageRecords![0]).toMatchObject({ requests: 2, reportedRequests: 2, days: { [localDay(new Date())]: 60 }, tools: [{ kind: 'mcp', name: '文档检索', count: 1 }, { kind: 'skill', name: '代码审查', count: 1 }] })
  session.send({ content: '', retry: true }, config)
  await agent.waitForIdle()
  store.apply({ type: 'conversation:delete', id: store.snapshot().activeConversationId! })
  expect(summarizeUsage(store.snapshot().usageRecords!).totalTokens).toBe(90)
  const restored = new StateService(new StateRepository(path))
  restored.authenticate(store.requireUser().id)
  expect(restored.snapshot().usageRecords).toEqual(store.snapshot().usageRecords)
  auth.logout()
  expect(store.snapshot().usageRecords).toEqual([])
  await auth.register({ username: 'usage-other', password: 'another-password' })
  expect(store.snapshot().usageRecords).toEqual([])
})

it('retains usage before failure and flags a request with no reported tokens', async () => {
  const { store } = await create()
  let calls = 0
  const agent = new Agent(new AgentLoop(async (_config, _messages, _controller, delta) => {
    if (calls++ === 0) delta({ totalTokens: 15 })
    throw new Error('断流')
  }), [])
  const session = new AgentSession(store, () => {}, agent, unexpectedTaskError)
  session.send({ content: '开始' }, config); await agent.waitForIdle()
  session.send({ content: '', retry: true }, config); await agent.waitForIdle()
  expect(summarizeUsage(store.snapshot().usageRecords!)).toMatchObject({ totalTokens: 15, missingRequests: 1 })
  expect(store.snapshot().usageRecords!.every(r => r.finishedAt)).toBe(true)
})

it('allocates cumulative increments across local midnight and preserves them when stopped', async () => {
  const { store, path } = await create()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-06-01T23:59:59'))
  let ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  const agent = new Agent(new AgentLoop(async (_config, _messages, controller, delta) => {
    delta({ totalTokens: 10 })
    vi.setSystemTime(new Date('2026-06-02T00:00:01'))
    delta({ totalTokens: 30 })
    ready()
    return await new Promise((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason)))
  }), [])
  const session = new AgentSession(store, () => {}, agent, unexpectedTaskError)
  session.send({ content: '跨日' }, config)
  await started
  const result = await session.stop()
  expect(result.usageRecords![0].days).toEqual({ '2026-06-01': 10, '2026-06-02': 20 })
  expect(summarizeUsage(result.usageRecords!).longestTaskMs).toBe(2000)
  expect(new StateRepository(path).state.users[0].usageRecords).toEqual(result.usageRecords)
})

it('keeps old files compatible, rejects malformed usage and does not count offline time after a crash', async () => {
  const { store, path } = await create()
  const old = JSON.parse(readFileSync(path, 'utf8'))
  expect(new StateRepository(path).state.users[0].usageRecords).toBeUndefined()
  const interrupted = { ...record({ '2026-01-01': 20 }), finishedAt: undefined }
  store.requireUser().usageRecords = [interrupted]; store.save()
  const restored = new StateService(new StateRepository(path))
  expect(restored.state.users[0].usageRecords![0].finishedAt).toBe(interrupted.lastActiveAt)
  expect(summarizeUsage(restored.state.users[0].usageRecords!).longestTaskMs).toBe(60_000)
  for (const broken of [{ ...interrupted, days: { '2026-02-30': 1 } }, { ...interrupted, days: { '2026-01-01': -1 } }, { ...interrupted, reportedRequests: 2 }, { ...interrupted, tools: [{ kind: 'fake', name: 'x', count: 1 }] }]) {
    expect(isUsageRecord(broken)).toBe(false)
    old.users[0].usageRecords = [broken]
    writeFileSync(path, JSON.stringify(old))
    expect(() => new StateRepository(path)).toThrow('无法读取本地数据')
  }
})
