import { afterEach, expect, it, vi } from 'vitest'
import { MainWindow } from '../../src/main/windows/main-window'
import { ApplicationErrors } from '../../src/main/app/application-errors'
import type { AgentSessions } from '../../src/main/services/agent-sessions'

const electron = vi.hoisted(() => ({ create: vi.fn(), showError: vi.fn() }))
vi.mock('electron', () => ({ BrowserWindow: electron.create, dialog: { showErrorBox: electron.showError } }))
afterEach(() => { vi.restoreAllMocks(); electron.create.mockReset(); electron.showError.mockReset() })

/** 模拟 Electron 可取消的 close 事件，检查失败不会继续关闭且可以再次尝试。 */
function fixture(loadError?: Error) {
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  const listeners = new Map<string, (event: { preventDefault(): void }) => void>()
  const window = {
    webContents: { setWindowOpenHandler: vi.fn(), on: vi.fn(), session: { setPermissionRequestHandler: vi.fn() } },
    once: vi.fn(), on: (name: string, callback: (event: { preventDefault(): void }) => void) => listeners.set(name, callback),
    show: vi.fn(), loadFile: vi.fn().mockResolvedValue(undefined), loadURL: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(() => {
      const event = { preventDefault: vi.fn() }
      listeners.get('close')?.(event)
      if (!event.preventDefault.mock.calls.length) listeners.get('closed')?.(event)
    })
  }
  electron.create.mockImplementation(function () { return window })
  if (loadError) window.loadFile.mockRejectedValue(loadError)
  const stopAll = vi.fn()
  const main = new MainWindow({ stopAll } as unknown as AgentSessions, { icon: '', preload: '', renderer: '' }, new ApplicationErrors())
  main.create()
  return { main, window, stopAll, diagnostic }
}

it('reports shutdown failures, keeps the window open and allows a successful retry', async () => {
  const { main, window, stopAll } = fixture()
  stopAll.mockRejectedValueOnce(new Error('保存失败')).mockResolvedValueOnce({})
  window.close()
  await vi.waitFor(() => expect(electron.showError).toHaveBeenCalledWith('任务停止失败', '保存失败'))
  expect(main.current).toBe(window)
  expect(window.close).toHaveBeenCalledOnce()
  window.close()
  await vi.waitFor(() => expect(main.current).toBeNull())
  expect(stopAll).toHaveBeenCalledTimes(2)
})

it('waits for persistence even when tasks are idle before closing the window', async () => {
  const { main, window, stopAll } = fixture()
  let finish!: () => void
  stopAll.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve }))
  window.close()
  window.close()
  expect(main.current).toBe(window)
  expect(stopAll).toHaveBeenCalledOnce()
  finish()
  await vi.waitFor(() => expect(main.current).toBeNull())
  expect(stopAll).toHaveBeenCalledOnce()
  expect(electron.showError).not.toHaveBeenCalled()
})

it('does not intercept the application quit after global persistence has completed', () => {
  const { main, window, stopAll } = fixture()
  main.allowClose()
  window.close()
  expect(main.current).toBeNull()
  expect(stopAll).not.toHaveBeenCalled()
})

it('routes page loading rejection through the application boundary', async () => {
  const error = new Error('页面文件不存在')
  const { diagnostic } = fixture(error)
  await vi.waitFor(() => expect(electron.showError).toHaveBeenCalledWith('窗口加载失败', error.message))
  expect(diagnostic).toHaveBeenCalledWith('窗口加载失败', error)
})

it('restores the close state when stopping throws synchronously', async () => {
  const { main, window, stopAll } = fixture()
  stopAll.mockImplementationOnce(() => { throw new Error('无法停止') }).mockResolvedValueOnce({})
  window.close()
  await vi.waitFor(() => expect(electron.showError).toHaveBeenCalledWith('任务停止失败', '无法停止'))
  window.close()
  await vi.waitFor(() => expect(main.current).toBeNull())
})
