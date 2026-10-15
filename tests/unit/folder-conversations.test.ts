import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { DesktopService } from '../../src/main/services/desktop-service'
import { ElectronDesktop } from '../../src/main/infrastructure/electron-desktop'
import { StateRepository } from '../../src/main/repositories/state-repository'
import { contextMessages } from '../../src/shared/context'
import { create, cleanup, config } from './helpers'

const native = vi.hoisted(() => ({ documents: '', choose: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => native.documents }, dialog: { showOpenDialog: native.choose } }))
afterEach(() => { vi.restoreAllMocks(); cleanup() })

it('selects a folder without reading its contents and creates unique default directories on cancellation', async () => {
  const { directory } = await create(config, false)
  native.documents = directory
  const desktop = new ElectronDesktop(() => null)
  native.choose.mockResolvedValueOnce({ canceled: false, filePaths: [directory] })
  expect(await desktop.selectDirectory()).toBe(realpathSync(directory))
  expect(existsSync(join(directory, 'DCode'))).toBe(false)
  native.choose.mockResolvedValue({ canceled: true, filePaths: [] })
  const first = await desktop.selectDirectory()
  const second = await desktop.selectDirectory()
  expect(first).not.toBe(second)
  expect(readdirSync(join(directory, 'DCode'))).toHaveLength(2)
  expect(first.split('/').at(-1)).toMatch(/^dcode-\d{8}-\d{12}$/)
  await expect(desktop.checkDirectory(first)).resolves.toBeUndefined()
})

it('persists empty conversations, reuses their folder and checks account ownership and missing directories', async () => {
  const { store, auth, directory, path } = await create(config, false)
  const selected = join(directory, 'project')
  mkdirSync(selected)
  native.choose.mockResolvedValue({ canceled: false, filePaths: [selected] })
  const desktop = new DesktopService(store, new ElectronDesktop(() => null))
  const first = await desktop.createConversation()
  const id = first.activeConversationId!
  expect(first.conversations[0]).toMatchObject({ directory: realpathSync(selected), title: '新对话', messages: [] })
  expect(new StateRepository(path).state.conversations[0]).toEqual(first.conversations[0])
  native.choose.mockClear()
  const second = await desktop.createConversation(id)
  expect(native.choose).not.toHaveBeenCalled()
  expect(second.conversations).toHaveLength(2)
  expect(new Set(second.conversations.map(c => c.directory)).size).toBe(1)
  expect(second.activeConversationId).not.toBe(id)
  store.begin('第一问', false, 'test')
  expect(store.snapshot().conversations[1].title).toBe('第一问')
  expect(contextMessages(store.conversation(id))[0].content).toContain(realpathSync(selected))
  const broken = store.createConversation(join(directory, 'missing'))
  const before = store.snapshot()
  await expect(desktop.createConversation(broken.id)).rejects.toThrow('工作文件夹不存在')
  expect(store.snapshot()).toEqual(before)
  auth.logout()
  await auth.register({ username: 'another', password: 'another-password' })
  await expect(desktop.createConversation(id)).rejects.toThrow('会话不存在')
  expect(store.snapshot().conversations).toEqual([])
})

it('requires a directory-backed conversation before sending and rolls back a failed creation', async () => {
  const { store } = await create(config, false)
  expect(() => store.begin('问题', false, 'test')).toThrow('选择工作文件夹')
  expect(store.state.conversations).toHaveLength(0)
  vi.spyOn(StateRepository.prototype, 'save').mockImplementationOnce(() => { throw new Error('保存失败') })
  expect(() => store.createConversation('/workspace')).toThrow('保存失败')
  expect(store.state.activeConversationId).toBeNull()
  expect(store.state.conversations).toHaveLength(0)
})
