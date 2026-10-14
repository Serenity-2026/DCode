import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AgentSessions } from '../../src/main/services/agent-sessions'
import { AgentSession } from '../../src/main/services/agent-session'
import { Agent } from '../../src/main/services/agent'
import { AgentLoop } from '../../src/main/services/agent-loop'
import { ToolRuntime } from '../../src/main/infrastructure/tools/tool-runtime'
import { ReadTool } from '../../src/main/infrastructure/tools/read'
import { readAttachments } from '../../src/main/infrastructure/attachments'
import type { AssistantMessage, LlmDelta, LlmMessage, ModelStream } from '../../src/main/domain/llm'
import type { StreamEvent } from '../../src/shared/types'
import { create, cleanup, config } from './helpers'

const managers: AgentSessions[] = []
afterEach(async () => {
  for (const manager of managers.splice(0)) { await manager.stopAll(); try { manager.dispose() } catch {} }
  cleanup()
})

/** 使用真实 Agent/工具/存储，以可控制的模型端口观察两个同时运行的任务。 */
async function fixture() {
  const base = await create()
  const pending = new Map<string, { controller: AbortController; delta: (delta: LlmDelta) => void; finish: () => void; messages: LlmMessage[] }>()
  const events: StreamEvent[] = []
  const agents: Agent[] = []
  const stream: ModelStream = async (selected, messages, controller, onDelta) => {
    if (!messages.some(message => message.role === 'toolResult')) return { role: 'assistant', stopReason: 'toolCall', content: [{ type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'value.txt' } }] }
    return new Promise<AssistantMessage>((resolve, reject) => {
      onDelta({ content: `${selected.model}:部分` })
      const abort = (): void => { pending.delete(selected.model); reject(controller.signal.reason) }
      controller.signal.addEventListener('abort', abort, { once: true })
      pending.set(selected.model, {
        controller, delta: onDelta, messages,
        finish: () => {
          controller.signal.removeEventListener('abort', abort)
          pending.delete(selected.model)
          onDelta({ content: ':完成' })
          resolve({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: `${selected.model}:部分:完成` }] })
        }
      })
    })
  }
  const loop = new AgentLoop(stream)
  const sessions = new AgentSessions(base.store, () => {
    const runtime = new ToolRuntime()
    const agent = new Agent(loop, [runtime.bind(new ReadTool())])
    agents.push(agent)
    return { session: new AgentSession(base.store, event => events.push(event), agent, runtime), dispose: () => runtime.dispose() }
  })
  managers.push(sessions)
  for (const name of ['A', 'B']) {
    mkdirSync(join(base.directory, name))
    writeFileSync(join(base.directory, name, 'value.txt'), `file-${name}`)
  }
  const send = async (name: string) => {
    const attachments = (await readAttachments([join(base.directory, name)], 'folder')).attachments
    return sessions.send({ content: `question-${name}`, conversationId: null, attachments }, { ...config, model: name }).activeConversationId!
  }
  return { ...base, sessions, pending, agents, events, send }
}

it('runs two independent agents, directories and model contexts and stops only the requested conversation', async () => {
  const { sessions, pending, agents, store, send, path, events } = await fixture()
  const a = await send('A')
  const b = await send('B')
  await vi.waitFor(() => expect(pending.size).toBe(2))
  expect(agents).toHaveLength(2)
  expect(sessions.isBusy(a)).toBe(true)
  expect(sessions.isBusy(b)).toBe(true)
  expect(agents.map(agent => agent.state.model?.model)).toEqual(['A', 'B'])
  expect(pending.get('A')!.messages.find(message => message.role === 'toolResult')).toMatchObject({ content: [{ type: 'text', text: 'file-A' }] })
  expect(pending.get('B')!.messages.find(message => message.role === 'toolResult')).toMatchObject({ content: [{ type: 'text', text: 'file-B' }] })
  expect(JSON.stringify(pending.get('B')!.messages)).not.toContain('question-A')
  const controllerB = pending.get('B')!.controller
  const stopped = await sessions.stop(a)
  expect(stopped.activeConversationId).toBe(b)
  expect(stopped.conversations.find(c => c.id === a)!.messages[1]).toMatchObject({ status: 'stopped', content: 'A:部分' })
  expect(controllerB.signal.aborted).toBe(false)
  expect(sessions.isBusy(b)).toBe(true)
  pending.get('B')!.finish()
  await agents[1].waitForIdle()
  expect(store.conversation(b).messages[1]).toMatchObject({ status: 'complete', content: 'B:部分:完成' })
  expect(sessions.busy).toBe(false)
  expect(new Set(events.map(event => event.conversationId))).toEqual(new Set([a, b]))
  expect(JSON.parse(readFileSync(path, 'utf8')).conversations.map((c: { messages: { status: string }[] }) => c.messages[1].status)).toEqual(['stopped', 'complete'])
})

it('rejects overlapping sends and deletion in one conversation while another can run', async () => {
  const { sessions, pending, send, store } = await fixture()
  const a = await send('A')
  await vi.waitFor(() => expect(pending.has('A')).toBe(true))
  expect(() => sessions.send({ content: 'duplicate', conversationId: a }, config)).toThrow('先停止')
  expect(() => sessions.send({ content: '', retry: true, conversationId: a }, config)).toThrow('先停止')
  expect(() => sessions.remove(a)).toThrow('先停止')
  store.apply({ type: 'conversation:select', id: null })
  const b = await send('B')
  await vi.waitFor(() => expect(pending.size).toBe(2))
  expect(store.state.activeConversationId).toBe(b)
  expect(sessions.isBusy(a)).toBe(true)
  await sessions.stop(a)
  sessions.remove(a)
  store.apply({ type: 'conversation:delete', id: a })
  expect(sessions.isBusy(b)).toBe(true)
})

it('keeps both stream targets attached to current repository objects after an unrelated transaction rollback', async () => {
  const { sessions, pending, send, store, path } = await fixture()
  const a = await send('A')
  const b = await send('B')
  await vi.waitFor(() => expect(pending.size).toBe(2))
  const old = store.state.conversations
  expect(() => store.transaction(() => { store.state.conversations[0].title = 'bad'; throw new Error('rollback') })).toThrow('rollback')
  expect(store.state.conversations).not.toBe(old)
  pending.get('A')!.delta({ content: ':回滚后' })
  pending.get('B')!.delta({ content: ':回滚后' })
  await sessions.stopAll()
  expect(store.conversation(a).messages[1].content).toBe('A:部分:回滚后')
  expect(store.conversation(b).messages[1].content).toBe('B:部分:回滚后')
  expect(JSON.parse(readFileSync(path, 'utf8')).conversations.map((c: { messages: { content: string }[] }) => c.messages[1].content)).toEqual(['A:部分:回滚后', 'B:部分:回滚后'])
})

it('stops every task and rejects new sends while shutdown is awaiting persistence', async () => {
  const { sessions, pending, send, store } = await fixture()
  await send('A'); await send('B')
  await vi.waitFor(() => expect(pending.size).toBe(2))
  const stopped = sessions.stopAll()
  expect(() => sessions.send({ content: 'during-stop', conversationId: null }, config)).toThrow('正在停止')
  await stopped
  expect(sessions.busy).toBe(false)
  expect(store.state.conversations.map(c => c.messages[1].status)).toEqual(['stopped', 'stopped'])
  expect(pending.size).toBe(0)
})

it('rejects forged and cross-account conversation targets for sending and stopping', async () => {
  const { sessions, pending, send, auth, store } = await fixture()
  const a = await send('A')
  await vi.waitFor(() => expect(pending.has('A')).toBe(true))
  expect(() => sessions.send({ content: 'bad', conversationId: 'missing' }, config)).toThrow('会话不存在')
  await expect(sessions.stop('missing')).rejects.toThrow('会话不存在')
  await sessions.stopAll()
  auth.logout()
  await auth.register({ username: 'another', password: 'another-password' })
  expect(() => sessions.send({ content: 'private', conversationId: a }, config)).toThrow('会话不存在')
  await expect(sessions.stop(a)).rejects.toThrow('会话不存在')
  expect(store.snapshot().conversations).toEqual([])
})

it('reuses the conversation runtime for an explicitly targeted followup without changing the selected page', async () => {
  const { sessions, pending, send, store, agents } = await fixture()
  const a = await send('A')
  const b = await send('B')
  await vi.waitFor(() => expect(pending.size).toBe(2))
  pending.get('A')!.finish()
  await agents[0].waitForIdle()
  sessions.send({ content: 'followup-A', conversationId: a }, { ...config, model: 'A' })
  await vi.waitFor(() => expect(pending.size).toBe(2))
  expect(agents).toHaveLength(2)
  expect(store.state.activeConversationId).toBe(b)
  expect(pending.get('A')!.messages.find(message => message.role === 'toolResult')).toMatchObject({ content: [{ type: 'text', text: 'file-A' }] })
  expect(JSON.stringify(pending.get('A')!.messages)).toContain('followup-A')
  expect(JSON.stringify(pending.get('A')!.messages)).not.toContain('question-B')
})

it('attempts cleanup of every conversation and reports resource cleanup failures', async () => {
  const { store } = await create()
  const first = vi.fn(() => { throw new Error('清理失败') })
  const second = vi.fn()
  const disposers = [first, second]
  const sessions = new AgentSessions(store, () => ({
    session: new AgentSession(store, () => {}, new Agent(new AgentLoop(async () => ({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] })), [])),
    dispose: disposers.shift()!
  }))
  managers.push(sessions)
  sessions.send({ content: 'first', conversationId: null }, config)
  sessions.send({ content: 'second', conversationId: null }, config)
  await sessions.stopAll()
  expect(() => sessions.dispose()).toThrow('清理失败')
  expect(first).toHaveBeenCalledOnce()
  expect(second).toHaveBeenCalledOnce()
})
