import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StreamEvent } from '../../src/shared/types'
import { FileChanges } from '../../src/main/file/file-changes'
import { StateRepository } from '../../src/main/repositories/state-repository'
import { StateService } from '../../src/main/services/state-service'
import { ToolRuntime } from '../../src/main/infrastructure/tools/tool-runtime'
import { ReadTool } from '../../src/main/infrastructure/tools/read'
import { WriteTool } from '../../src/main/infrastructure/tools/write'
import { EditTool } from '../../src/main/infrastructure/tools/edit'
import { Auth } from '../../src/main/services/auth-service'
import { Models } from '../../src/main/services/model-service'
import { AgentSession } from '../../src/main/agent/agent-session'
import { cleanup, config, create, createAgent, secrets, unexpectedTaskError } from './helpers'
import { openAIResponse, testCall } from './llm-fixtures'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); cleanup() })

/** 在隔离目录使用真实工具、状态仓库和备份服务，按用户提问固定本轮回复。 */
async function fixture() {
  const base = await create()
  const events: StreamEvent[] = []
  const changes = new FileChanges(base.store, event => events.push(event))
  const runtime = new ToolRuntime((...args) => changes.record(...args))
  runtime.setDirectory(base.directory)
  const tools = [new ReadTool(), new WriteTool(), new EditTool()].map(tool => runtime.bind(tool))
  const next = (retry = false) => {
    const { conversation, message } = base.store.begin('修改文件', retry, config.model)
    runtime.setTurn({ conversationId: conversation.id, messageId: message.id })
    return { conversationId: conversation.id, messageId: message.id }
  }
  const turn = next()
  const run = (name: string, args: Record<string, unknown>, signal = new AbortController().signal) => tools.find(tool => tool.name === name)!.execute(args, signal)
  const publicChanges = (id = turn.messageId) => base.store.snapshot().conversations.flatMap(c => c.messages).find(m => m.id === id)!.fileChanges || []
  return { ...base, changes, runtime, run, next, turn, events, publicChanges }
}

it('groups repeated writes and edits by file and restores exact original bytes or deletes new empty files', async () => {
  const f = await fixture()
  const path = join(f.directory, 'original.txt')
  const original = '\ufeff第一行\r\n第二行\r\n'
  writeFileSync(path, original)
  await f.run('read', { path })
  await f.run('edit', { path, edits: [{ oldText: '第一行', newText: '修改一' }] })
  await f.run('write', { path, content: '最终内容\n' })
  await f.run('write', { path: 'empty.txt', content: '' })
  expect(f.publicChanges()).toMatchObject([
    { path: 'original.txt', additions: 1, deletions: 2, status: 'applied', preview: { content: '最终内容\n' } },
    { path: 'empty.txt', additions: 0, deletions: 0 }
  ])
  expect(f.store.state.fileChanges).toHaveLength(2)
  const first = f.publicChanges()[0]
  await f.changes.undo({ ...f.turn, changeId: first.id })
  expect(readFileSync(path)).toEqual(Buffer.from(original))
  expect(existsSync(join(f.directory, 'empty.txt'))).toBe(true)
  expect(f.publicChanges().map(change => change.status)).toEqual(['reverted', 'applied'])
  await f.changes.undo(f.turn)
  expect(existsSync(join(f.directory, 'empty.txt'))).toBe(false)
  expect(f.publicChanges().every(change => change.status === 'reverted')).toBe(true)
  expect(f.store.conversation(f.turn.conversationId).messages).toHaveLength(2)
  expect(f.events.at(-1)!.message.fileChanges?.map(change => change.status)).toEqual(['reverted', 'reverted'])
})

it('persists full backups beyond preview limits and keeps backups out of IPC and model results after restart', async () => {
  const f = await fixture()
  const path = join(f.directory, 'large.txt')
  const original = `${'保留原文\n'.repeat(2500)}\ufeff尾部\r\n`
  writeFileSync(path, original)
  await f.run('read', { path })
  const result = await f.run('write', { path, content: `新内容\n${original}` })
  expect(f.publicChanges()[0].preview.truncated).toBe(true)
  expect(f.publicChanges()[0].additions).toBe(1)
  expect(Object.keys(f.publicChanges()[0]).sort()).toEqual(['additions', 'deletions', 'id', 'path', 'preview', 'status'])
  expect(result.content).toEqual([{ type: 'text', text: `已写入：${path}` }])
  const store = new StateService(new StateRepository(f.path))
  const auth = new Auth(store, secrets, new Models(store, secrets, config))
  await auth.restore()
  const restored = new FileChanges(store, () => {})
  await restored.recover()
  await restored.undo(f.turn)
  expect(readFileSync(path, 'utf8')).toBe(original)
})

it('preflights the whole turn and refuses to overwrite later external changes', async () => {
  const f = await fixture()
  await f.run('write', { path: 'a.txt', content: '模型 A' })
  await f.run('write', { path: 'b.txt', content: '模型 B' })
  writeFileSync(join(f.directory, 'b.txt'), '用户后续修改')
  await expect(f.changes.undo(f.turn)).rejects.toThrow('后续修改')
  expect(readFileSync(join(f.directory, 'a.txt'), 'utf8')).toBe('模型 A')
  expect(readFileSync(join(f.directory, 'b.txt'), 'utf8')).toBe('用户后续修改')
  expect(f.publicChanges().every(change => change.status === 'applied')).toBe(true)
  await f.changes.undo({ ...f.turn, changeId: f.publicChanges()[0].id })
  expect(existsSync(join(f.directory, 'a.txt'))).toBe(false)
})

it('protects later turns and other conversations, allowing reverse chronological undo', async () => {
  const f = await fixture()
  const path = join(f.directory, 'shared.txt')
  writeFileSync(path, '原文')
  await f.run('read', { path })
  await f.run('write', { path, content: '第一轮' })
  f.store.createConversation(f.directory)
  const second = f.next()
  await f.run('write', { path, content: '第二轮' })
  await expect(f.changes.undo(f.turn)).rejects.toThrow('后续修改')
  await f.changes.undo(second)
  expect(readFileSync(path, 'utf8')).toBe('第一轮')
  await f.changes.undo(f.turn)
  expect(readFileSync(path, 'utf8')).toBe('原文')
})

it('retains original backups and reassigns them to the new assistant message on regeneration', async () => {
  const f = await fixture()
  writeFileSync(join(f.directory, 'retry.txt'), '最初内容')
  await f.run('read', { path: 'retry.txt' })
  await f.run('write', { path: 'retry.txt', content: '第一次生成' })
  const retry = f.next(true)
  expect(retry.messageId).not.toBe(f.turn.messageId)
  await f.run('write', { path: 'retry.txt', content: '重新生成' })
  expect(f.publicChanges(retry.messageId)).toHaveLength(1)
  expect(() => new StateRepository(f.path)).not.toThrow()
  await f.changes.undo(retry)
  expect(readFileSync(join(f.directory, 'retry.txt'), 'utf8')).toBe('最初内容')
})

it('saves backups before invoking the writer and preserves partial or cancelled writes for undo', async () => {
  const f = await fixture()
  const path = join(f.directory, 'partial.txt')
  writeFileSync(path, '原内容')
  const controller = new AbortController()
  await expect(f.changes.record(f.turn, path, '原内容', '预期内容', async () => {
    expect(new StateRepository(f.path).state.fileChanges?.[0].status).toBe('pending')
    writeFileSync(path, '部分内容')
    controller.abort()
    controller.signal.throwIfAborted()
  })).rejects.toThrow()
  expect(f.publicChanges()[0]).toMatchObject({ status: 'applied', preview: { content: '部分内容' } })
  await f.changes.undo(f.turn)
  expect(readFileSync(path, 'utf8')).toBe('原内容')
})

it('never writes a file when saving its preimage fails', async () => {
  const f = await fixture()
  const save = vi.spyOn(f.store, 'transaction').mockImplementationOnce(() => { throw new Error('备份保存失败') })
  await expect(f.run('write', { path: 'new.txt', content: '不能写入' })).rejects.toThrow('备份保存失败')
  expect(existsSync(join(f.directory, 'new.txt'))).toBe(false)
  expect(f.store.state.fileChanges).toBeUndefined()
  save.mockRestore()
})

it('does not claim an external file when exclusive creation fails', async () => {
  const f = await fixture()
  const path = join(f.directory, 'raced.txt')
  await expect(f.changes.record(f.turn, path, null, '模型内容', async () => {
    writeFileSync(path, '外部新文件')
    throw Object.assign(new Error('already exists'), { code: 'EEXIST' })
  })).rejects.toThrow('already exists')
  expect(f.publicChanges()).toEqual([])
  await expect(f.changes.undo(f.turn)).rejects.toThrow('没有可撤销')
  expect(readFileSync(path, 'utf8')).toBe('外部新文件')
})

it('does not absorb external content observed after a successful writer into the undo target', async () => {
  const f = await fixture()
  const path = join(f.directory, 'external.txt')
  writeFileSync(path, '原文')
  await f.changes.record(f.turn, path, '原文', '模型修改', async () => {
    writeFileSync(path, '模型修改')
    writeFileSync(path, '外部后续编辑')
  })
  await expect(f.changes.undo(f.turn)).rejects.toThrow('后续修改')
  expect(readFileSync(path, 'utf8')).toBe('外部后续编辑')
})

it('recovers an interrupted saved write and retries persistence after a completed undo', async () => {
  const f = await fixture()
  await f.run('write', { path: 'interrupted.txt', content: '内容' })
  f.store.state.fileChanges![0].status = 'pending'
  f.store.save()
  await f.changes.recover()
  expect(f.publicChanges()[0].status).toBe('applied')
  const save = vi.spyOn(f.store, 'save').mockImplementationOnce(() => { throw new Error('磁盘已满') })
  await expect(f.changes.undo(f.turn)).rejects.toThrow('磁盘已满')
  expect(existsSync(join(f.directory, 'interrupted.txt'))).toBe(false)
  save.mockRestore()
  await f.changes.undo(f.turn)
  expect(new StateRepository(f.path).state.fileChanges![0].status).toBe('reverted')
})

it('rejects forged targets and cross-account undo without exposing backup data', async () => {
  const f = await fixture()
  await f.run('write', { path: 'owned.txt', content: '当前账号' })
  await expect(f.changes.undo({ ...f.turn, changeId: 'forged' })).rejects.toThrow('没有可撤销')
  await expect(f.changes.undo({ ...f.turn, messageId: 'forged' })).rejects.toThrow('回复不存在')
  f.auth.logout()
  await f.auth.register({ username: 'second-user', password: 'second-password' })
  await expect(f.changes.undo(f.turn)).rejects.toThrow('会话不存在')
  expect(f.store.snapshot().conversations).toEqual([])
  expect(readFileSync(join(f.directory, 'owned.txt'), 'utf8')).toBe('当前账号')
})

it('skips net-zero existing-file changes and cleans only records of deleted conversations', async () => {
  const f = await fixture()
  writeFileSync(join(f.directory, 'same.txt'), '原文')
  await f.run('read', { path: 'same.txt' })
  await f.run('write', { path: 'same.txt', content: '临时修改' })
  await f.run('write', { path: 'same.txt', content: '原文' })
  expect(f.publicChanges()).toEqual([])
  f.store.apply({ type: 'conversation:delete', id: f.turn.conversationId })
  expect(f.store.state.fileChanges).toEqual([])
  expect(readFileSync(join(f.directory, 'same.txt'), 'utf8')).toBe('原文')
})

it('refuses linked files and changed parent directories without affecting their targets', async () => {
  const f = await fixture()
  const path = join(f.directory, 'linked.txt')
  writeFileSync(path, '原文')
  linkSync(path, join(f.directory, 'hard.txt'))
  await f.run('read', { path })
  await expect(f.run('write', { path, content: '覆盖' })).rejects.toThrow('链接')
  mkdirSync(join(f.directory, 'parent'))
  await f.run('write', { path: 'parent/file.txt', content: '模型内容' })
  renameSync(join(f.directory, 'parent'), join(f.directory, 'moved'))
  mkdirSync(join(f.directory, 'other'))
  writeFileSync(join(f.directory, 'other/file.txt'), '模型内容')
  symlinkSync(join(f.directory, 'other'), join(f.directory, 'parent'))
  await expect(f.changes.undo(f.turn)).rejects.toThrow('目录已变化')
  expect(readFileSync(join(f.directory, 'other/file.txt'), 'utf8')).toBe('模型内容')
})

it('rejects malformed saved backup records instead of overwriting the state file', async () => {
  const f = await fixture()
  await f.run('write', { path: 'file.txt', content: '内容' })
  const state = JSON.parse(readFileSync(f.path, 'utf8'))
  state.fileChanges[0].before = 'not-base64'
  writeFileSync(f.path, JSON.stringify(state))
  expect(() => new StateRepository(f.path)).toThrow('无法读取本地数据')
  expect(JSON.parse(readFileSync(f.path, 'utf8')).fileChanges[0].before).toBe('not-base64')
})

it('projects production tool changes into the completed assistant reply and preserves them after a later model error', async () => {
  const f = await fixture()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(openAIResponse('', [{ ...testCall('new'), name: 'write', arguments: JSON.stringify({ path: 'agent.txt', content: '文件内容' }) }])).mockRejectedValueOnce(new Error('模型失败')))
  const agent = createAgent([f.runtime.bind(new WriteTool())])
  const session = new AgentSession(f.store, event => f.events.push(event), agent, unexpectedTaskError, f.runtime)
  const snapshot = session.send({ content: '新的一轮' }, config)
  await agent.waitForIdle()
  const message = f.events.at(-1)!.message
  expect(message.status).toBe('error')
  expect(message.fileChanges).toMatchObject([{ path: 'agent.txt', status: 'applied' }])
  await f.changes.undo({ conversationId: snapshot.activeConversationId!, messageId: message.id })
  expect(existsSync(join(f.directory, 'agent.txt'))).toBe(false)
})

it('waits for in-flight mutation recording on stop and keeps it attached to its original round', async () => {
  const f = await fixture()
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const runtime = new ToolRuntime(async (turn, path, before, after, write) => {
    entered()
    await held
    await f.changes.record(turn, path, before, after, write)
  })
  const agent = createAgent([runtime.bind(new WriteTool())])
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(openAIResponse('', [{ ...testCall('delayed'), name: 'write', arguments: JSON.stringify({ path: 'delayed.txt', content: '不应写入' }) }])))
  const session = new AgentSession(f.store, () => {}, agent, unexpectedTaskError, runtime)
  session.send({ content: '取消写入' }, config)
  await started
  let stopped = false
  const stopping = session.stop().then(() => { stopped = true })
  await agent.waitForIdle()
  expect(session.busy).toBe(true)
  expect(stopped).toBe(false)
  expect(() => session.send({ content: '下一轮' }, config)).toThrow('先停止')
  release()
  await stopping
  expect(session.busy).toBe(false)
  expect(existsSync(join(f.directory, 'delayed.txt'))).toBe(false)
})
