import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { Suggestions } from '../../src/main/services/suggestion-service'
import { StateRepository } from '../../src/main/repositories/state-repository'
import { StateService } from '../../src/main/services/state-service'
import { Agent } from '../../src/main/agent/agent'
import { AgentLoop } from '../../src/main/agent/agent-loop'
import { AgentSession } from '../../src/main/agent/agent-session'
import { AgentSessions } from '../../src/main/agent/agent-sessions'
import type { AssistantMessage, LlmDelta } from '../../src/main/domain/llm'
import type { StreamEvent } from '../../src/shared/types'
import { contextMessages, estimateContext } from '../../src/shared/context'
import { localDay, summarizeUsage } from '../../src/shared/usage'
import { streamModel } from '../../src/main/infrastructure/model-client'
import { anthropicResponse, openAIResponse } from './llm-fixtures'
import { create, cleanup, config, unexpectedTaskError } from './helpers'

const services: Suggestions[] = []
afterEach(() => { services.splice(0).forEach(service => service.cancel()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); cleanup() })
const reply = (suggestion = '为刚才的函数补充边界测试。'): AssistantMessage => ({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ suggestion }) }] })
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

/** 创建完成回复与真实用量记录，测试只使用系统临时目录。 */
async function completed() {
  const base = await create()
  const { conversation, message } = base.store.begin('实现函数', false, config.model)
  message.status = 'complete'; message.content = '函数已完成，还可以补充边界测试。'
  const usage = base.store.requireUser().usageRecords![0]
  usage.finishedAt = usage.lastActiveAt
  base.store.save()
  return { ...base, conversation, message }
}

/** 登记服务以便测试结束时取消剩余后台请求。 */
function service(store: StateService, emit: (event: StreamEvent) => void, stream = streamModel): Suggestions {
  const instance = new Suggestions(store, emit, stream)
  services.push(instance)
  return instance
}

it.each(['openai-completions', 'anthropic-messages'] as const)('generates with %s using the original model and no tools, persists and excludes suggestions from context', async api => {
  const { store, conversation, message, path } = await completed()
  const events: StreamEvent[] = []
  const selected = { ...config, api, model: 'original-model' }
  const response = api === 'openai-completions' ? openAIResponse : anthropicResponse
  const fetch = vi.fn().mockResolvedValue(response(JSON.stringify({ suggestion: '为刚才的函数补充边界测试。' })))
  vi.stubGlobal('fetch', fetch)
  const before = contextMessages(conversation)
  const estimate = estimateContext(conversation, '', [])
  service(store, event => events.push(event)).start(conversation.id, message.id, selected)
  await vi.waitFor(() => expect(store.conversation(conversation.id).messages.at(-1)?.suggestedPrompt).toBe('为刚才的函数补充边界测试。'))
  const body = JSON.parse(fetch.mock.calls[0][1].body)
  expect(body).toMatchObject({ model: 'original-model', max_tokens: 512 })
  expect(body).not.toHaveProperty('tools')
  expect(body).not.toHaveProperty('tool_choice')
  expect(fetch.mock.calls[0][0]).toBe(`${config.baseUrl}${api === 'openai-completions' ? '/chat/completions' : '/v1/messages'}`)
  expect(events.at(-1)).toMatchObject({ background: true, conversationId: conversation.id, message: { id: message.id, status: 'complete' } })
  expect(contextMessages(store.conversation(conversation.id))).toEqual(before)
  expect(estimateContext(store.conversation(conversation.id), '', [])).toBe(estimate)
  const restored = new StateService(new StateRepository(path))
  restored.authenticate(store.requireUser().id)
  expect(restored.snapshot().conversations[0].messages.at(-1)?.suggestedPrompt).toBe('为刚才的函数补充边界测试。')
})

it('bounds recent successful context and counts cumulative usage once without extending the main task', async () => {
  const { store, conversation } = await completed()
  for (let index = 0; index < 5; index++) {
    const { message } = store.begin(`问题${index}${'问'.repeat(4000)}`, false, config.model)
    message.content = `回复${index}${'答'.repeat(6000)}`; message.status = index === 3 ? 'error' : 'complete'
  }
  const message = conversation.messages.at(-1)!
  message.reasoning = '不发送推理'
  message.attachments = [{ id: 'a', kind: 'file', name: 'a.txt', fileCount: 1, content: '不发送附件' }]
  const record = store.requireUser().usageRecords!.at(-1)!
  record.finishedAt = record.lastActiveAt
  const end = record.finishedAt
  const stream = vi.fn<typeof streamModel>(async (_config, messages, _controller, onDelta) => {
    const transcript = JSON.parse((messages[1] as { content: string }).content)
    expect(transcript).toHaveLength(6)
    expect(transcript.filter((m: { role: string }) => m.role === 'user').every((m: { content: string }) => m.content.length <= 3000)).toBe(true)
    expect(transcript.filter((m: { role: string }) => m.role === 'assistant').every((m: { content: string }) => m.content.length <= 5000)).toBe(true)
    expect(JSON.stringify(messages)).not.toMatch(/不发送推理|不发送附件/)
    onDelta({ totalTokens: 10 }); onDelta({ totalTokens: 10 }); onDelta({ totalTokens: 5 }); onDelta({ totalTokens: 25 })
    return reply()
  })
  service(store, () => {}, stream).start(conversation.id, message.id, config)
  await vi.waitFor(() => expect(message.suggestedPrompt).toBeDefined())
  expect(record).toMatchObject({ requests: 1, reportedRequests: 1, days: { [localDay(new Date())]: 25 }, finishedAt: end })
  store.apply({ type: 'conversation:delete', id: conversation.id })
  expect(summarizeUsage(store.snapshot().usageRecords!).totalTokens).toBe(25)
})

it.each(['', '不是 JSON', '{"suggestion":""}', '{"suggestion":"第一行\\n第二行"}', JSON.stringify({ suggestion: '长'.repeat(161) }), 'null'])('silently discards unusable output %s without changing the completed answer', async text => {
  const { store, conversation, message } = await completed()
  const stream = vi.fn<typeof streamModel>().mockResolvedValue({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] })
  service(store, () => {}, stream).start(conversation.id, message.id, config)
  await flush()
  expect(message).toMatchObject({ status: 'complete', content: '函数已完成，还可以补充边界测试。' })
  expect(message.suggestedPrompt).toBeUndefined()
})

it.each(['error', 'stopped', 'streaming'] as const)('does not request suggestions for %s replies', async status => {
  const { store, conversation, message } = await completed()
  message.status = status
  const stream = vi.fn<typeof streamModel>()
  service(store, () => {}, stream).start(conversation.id, message.id, config)
  await flush()
  expect(stream).not.toHaveBeenCalled()
})

it('silently handles request errors, storage failures and total timeout', async () => {
  const { store, conversation, message } = await completed()
  const failed = vi.fn<typeof streamModel>().mockRejectedValue(new Error('服务失败'))
  service(store, () => {}, failed).start(conversation.id, message.id, config)
  await flush()
  expect(message.status).toBe('complete')
  const save = vi.spyOn(store, 'transaction').mockImplementationOnce(() => { throw new Error('磁盘失败') })
  service(store, () => {}, failed).start(conversation.id, message.id, config)
  await flush()
  expect(failed).toHaveBeenCalledTimes(1)
  save.mockRestore()
  vi.useFakeTimers()
  const slow = vi.fn<typeof streamModel>(async (_config, _messages, controller) => new Promise((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason))))
  service(store, () => {}, slow).start(conversation.id, message.id, config)
  await vi.advanceTimersByTimeAsync(15_000)
  expect(slow.mock.calls[0][2].signal.aborted).toBe(true)
  expect(message.suggestedPrompt).toBeUndefined()
  expect(message.status).toBe('complete')
})

it.each(['cancel', 'new-question', 'retry', 'delete', 'logout'] as const)('discards late output after %s and preserves already reported usage', async operation => {
  const { store, conversation, message, auth } = await completed()
  const events: StreamEvent[] = []
  let finish!: (value: AssistantMessage) => void
  let delta!: (value: LlmDelta) => void
  const stream = vi.fn<typeof streamModel>(async (_config, _messages, _controller, onDelta) => {
    delta = onDelta; onDelta({ totalTokens: 12 })
    return new Promise(resolve => { finish = resolve })
  })
  const suggestions = service(store, event => events.push(event), stream)
  suggestions.start(conversation.id, message.id, config)
  const user = store.requireUser()
  if (operation === 'cancel') suggestions.cancel()
  if (operation === 'new-question') store.begin('下一题', false, config.model)
  if (operation === 'retry') store.begin('', true, config.model)
  if (operation === 'delete') store.apply({ type: 'conversation:delete', id: conversation.id })
  if (operation === 'logout') { auth.logout(); await auth.register({ username: 'other-user', password: 'other-password' }) }
  const count = events.length
  // 模拟不配合取消的服务，只返回迟到结果，不再调用已经失效的流回调。
  if (operation === 'cancel') delta({ totalTokens: 99 })
  finish(reply()); await flush()
  expect(events).toHaveLength(count)
  expect(message.suggestedPrompt).toBeUndefined()
  expect(summarizeUsage(user.usageRecords!).totalTokens).toBe(12)
  if (operation === 'logout') expect(store.snapshot().usageRecords).toEqual([])
})

it('keeps parallel conversations independent and cancels through send, removal and stopAll', async () => {
  const { store, directory } = await create()
  const pending: { controller: AbortController; finish: (value: AssistantMessage) => void }[] = []
  const agents: Agent[] = []
  const stream = vi.fn<typeof streamModel>(async (_config, _messages, controller) => new Promise(resolve => pending.push({ controller, finish: resolve })))
  const sessions = new AgentSessions(store, () => {
    const suggestions = service(store, () => {}, stream)
    const agent = new Agent(new AgentLoop(async (_config, _messages, _controller, onDelta) => {
      onDelta({ content: '已完成' })
      return { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '已完成' }] }
    }), [])
    agents.push(agent)
    const session = new AgentSession(store, () => {}, agent, unexpectedTaskError, undefined, suggestions)
    return { session, dispose: () => session.cancelSuggestions() }
  })
  try {
    const first = store.snapshot().activeConversationId!
    sessions.send({ content: '第一题', conversationId: first }, config)
    await agents[0].waitForIdle(); await flush()
    const second = store.createConversation(directory).id
    sessions.send({ content: '第二题', conversationId: second }, config)
    await agents[1].waitForIdle(); await flush()
    expect(sessions.busy).toBe(false)
    expect(pending).toHaveLength(2)
    pending[0].finish(reply('第一个会话的建议')); await flush()
    expect(store.conversation(first).messages.at(-1)?.suggestedPrompt).toBe('第一个会话的建议')
    expect(store.conversation(second).messages.at(-1)?.suggestedPrompt).toBeUndefined()
    sessions.send({ content: '', retry: true, conversationId: second }, config)
    expect(pending[1].controller.signal.aborted).toBe(true)
    await agents[1].waitForIdle(); await flush()
    sessions.remove(second)
    store.apply({ type: 'conversation:delete', id: second })
    expect(pending[2].controller.signal.aborted).toBe(true)
    sessions.send({ content: '新的问题', conversationId: first }, config)
    await agents[0].waitForIdle(); await flush()
    await sessions.stopAll()
    expect(pending[3].controller.signal.aborted).toBe(true)
  } finally {
    await sessions.stopAll(); sessions.dispose()
    pending.forEach(item => item.finish(reply())); await flush()
  }
})

it('accepts old stored messages but rejects malformed suggestion fields', async () => {
  const { store, message, path } = await completed()
  expect(new StateRepository(path).state.conversations[0].messages.at(-1)?.suggestedPrompt).toBeUndefined()
  message.suggestedPrompt = '继续检查边界条件。'; store.save()
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  for (const value of [null, 42, '', 'x'.repeat(161), '两行\n建议']) {
    saved.conversations[0].messages[1].suggestedPrompt = value
    writeFileSync(path, JSON.stringify(saved))
    expect(() => new StateRepository(path)).toThrow('无法读取本地数据')
  }
})
