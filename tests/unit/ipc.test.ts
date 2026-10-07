import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IpcRouter } from '../../src/main/ipc/ipc-router'
import { registerChatController } from '../../src/main/controllers/chat-controller'
import { AgentSession } from '../../src/main/services/agent-session'
import { channels } from '../../src/shared/channels'
import { cleanup, create, createAgent } from './helpers'

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
  const router = new IpcRouter(() => current, () => false)
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
  const router = new IpcRouter(() => window, () => false)
  router.handle<string>('success', async input => ({ input }))
  router.handle('failure', () => { throw new Error('业务失败') })
  await expect(handlers.get('success')!(event, 'payload')).resolves.toEqual({ ok: true, value: { input: 'payload' } })
  await expect(handlers.get('failure')!(event)).resolves.toEqual({ ok: false, error: '业务失败' })
})

it('rejects overlapping operations and releases its guard after success or failure', async () => {
  const router = new IpcRouter(() => null, () => false)
  let release!: () => void
  const first = router.exclusive(() => new Promise<void>(resolve => { release = resolve }))
  await expect(router.exclusive(() => 'overlap')).rejects.toThrow('请等待')
  release()
  await first
  await expect(router.exclusive(() => { throw new Error('失败') })).rejects.toThrow('失败')
  await expect(router.exclusive(() => 'next')).resolves.toBe('next')
})

it('routes stop through the actual session controller even while generation blocks send', async () => {
  const { store, models } = await create()
  const session = new AgentSession(store, () => {}, createAgent())
  vi.spyOn(session, 'busy', 'get').mockReturnValue(true)
  const stop = vi.spyOn(session, 'stop').mockResolvedValue(store.snapshot())
  const selected = vi.spyOn(models, 'selected')
  const { window, event } = source()
  const router = new IpcRouter(() => window, () => session.busy)
  registerChatController(router, session, models, store)
  await expect(handlers.get(channels.send)!(event, { content: 'blocked' })).resolves.toMatchObject({ ok: false })
  expect(selected).not.toHaveBeenCalled()
  await expect(handlers.get(channels.stop)!(event)).resolves.toMatchObject({ ok: true })
  expect(stop).toHaveBeenCalledOnce()
})
