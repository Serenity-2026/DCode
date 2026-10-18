import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IpcRouter } from '../../src/main/ipc/ipc-router'
import { registerChatController } from '../../src/main/controllers/chat-controller'
import { AgentSession } from '../../src/main/agent/agent-session'
import { AgentSessions } from '../../src/main/agent/agent-sessions'
import { registerStateController } from '../../src/main/controllers/state-controller'
import { registerAuthController } from '../../src/main/controllers/auth-controller'
import { registerFileChangeController } from '../../src/main/controllers/file-change-controller'
import { FileChanges } from '../../src/main/file/file-changes'
import { channels } from '../../src/shared/channels'
import { cleanup, create, createAgent, unexpectedTaskError } from './helpers'

const handlers = vi.hoisted(() => new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>>())
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>) => handlers.set(channel, handler) } }))
beforeEach(() => handlers.clear())
afterEach(() => { vi.restoreAllMocks(); cleanup() })

/** 构造与当前窗口相同的 sender/frame，用于测试真实 IPC Router 的来源检查。 */
function source() {
  const contents = { mainFrame: {} }
  const window = { webContents: contents } as unknown as BrowserWindow
  const event = { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainInvokeEvent
  return { window, event }
}

it('rejects another window, child frame and a closed window before calling business code', async () => {
  const { window, event } = source()
  let current: BrowserWindow | null = window
  const router = new IpcRouter(() => current)
  const operation = vi.fn(() => 'private-result')
  router.handle('test', operation)
  const invoke = handlers.get('test')!
  await expect(invoke({ ...event, sender: {} } as IpcMainInvokeEvent)).resolves.toEqual({ ok: false, error: '无权执行此操作。' })
  await expect(invoke({ ...event, senderFrame: {} } as IpcMainInvokeEvent)).resolves.toEqual({ ok: false, error: '无权执行此操作。' })
  current = null
  await expect(invoke(event)).resolves.toEqual({ ok: false, error: '无权执行此操作。' })
  expect(operation).not.toHaveBeenCalled()
})

it('wraps awaited business results and failures in the existing Result protocol', async () => {
  const { window, event } = source()
  const router = new IpcRouter(() => window)
  router.handle<string>('success', async input => ({ input }))
  router.handle('failure', () => { throw new Error('业务失败') })
  await expect(handlers.get('success')!(event, 'payload')).resolves.toEqual({ ok: true, value: { input: 'payload' } })
  await expect(handlers.get('failure')!(event)).resolves.toEqual({ ok: false, error: '业务失败' })
})

it('rejects overlapping operations and releases its guard after success or failure', async () => {
  const router = new IpcRouter(() => null)
  let release!: () => void
  const first = router.exclusive(() => new Promise<void>(resolve => { release = resolve }))
  await expect(router.exclusive(() => 'overlap')).rejects.toThrow('请等待')
  release()
  await first
  await expect(router.exclusive(() => { throw new Error('失败') })).rejects.toThrow('失败')
  await expect(router.exclusive(() => 'next')).resolves.toBe('next')
})

it('routes conversation navigation and stopping with explicit conversation identity', async () => {
  const { store, models } = await create()
  const sessions = new AgentSessions(store, () => ({ session: new AgentSession(store, () => {}, createAgent(), unexpectedTaskError), dispose: () => {} }))
  const { conversation } = store.begin('原会话', false, 'test')
  const stop = vi.spyOn(sessions, 'stop').mockResolvedValue(store.snapshot())
  const { window, event } = source()
  const router = new IpcRouter(() => window)
  registerChatController(router, sessions, models, store)
  registerStateController(router, store, sessions)
  await expect(handlers.get(channels.action)!(event, { type: 'conversation:select', id: null })).resolves.toMatchObject({ ok: true })
  await expect(handlers.get(channels.stop)!(event, conversation.id)).resolves.toMatchObject({ ok: true })
  expect(stop).toHaveBeenCalledWith(conversation.id)
})

it('waits for all tasks before revoking authentication', async () => {
  const { store, auth } = await create()
  const sessions = new AgentSessions(store, () => ({ session: new AgentSession(store, () => {}, createAgent(), unexpectedTaskError), dispose: () => {} }))
  let release!: () => void
  const pending = new Promise<ReturnType<typeof store.snapshot>>(resolve => { release = () => resolve(store.snapshot()) })
  const stopAll = vi.spyOn(sessions, 'stopAll').mockReturnValue(pending)
  const { window, event } = source()
  const router = new IpcRouter(() => window)
  registerAuthController(router, auth, sessions)
  const logout = handlers.get(channels.logout)!(event)
  expect(stopAll).toHaveBeenCalledOnce()
  expect(store.snapshot().activeUserId).not.toBeNull()
  release()
  await expect(logout).resolves.toMatchObject({ ok: true, value: { activeUserId: null } })
})

it('protects file undo from running agents and holds the IPC guard until restoration finishes', async () => {
  const { store } = await create()
  const sessions = new AgentSessions(store, () => ({ session: new AgentSession(store, () => {}, createAgent(), unexpectedTaskError), dispose: () => {} }))
  const changes = new FileChanges(store, () => {})
  let release!: () => void
  const undo = vi.spyOn(changes, 'undo').mockImplementation(() => new Promise(resolve => { release = () => resolve(store.snapshot()) }))
  const running = vi.spyOn(sessions, 'busy', 'get').mockReturnValue(true)
  const { window, event } = source()
  const router = new IpcRouter(() => window)
  registerFileChangeController(router, changes, sessions)
  const input = { conversationId: store.state.activeConversationId!, messageId: 'target', changeId: 'file' }
  await expect(handlers.get(channels.undoFiles)!(event, input)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('请先停止') })
  expect(undo).not.toHaveBeenCalled()
  running.mockReturnValue(false)
  const pending = handlers.get(channels.undoFiles)!(event, input)
  await expect(router.exclusive(() => 'new task')).rejects.toThrow('请等待')
  release()
  await expect(pending).resolves.toMatchObject({ ok: true })
  expect(undo).toHaveBeenCalledWith(input)
  await expect(router.exclusive(() => 'next')).resolves.toBe('next')
})
