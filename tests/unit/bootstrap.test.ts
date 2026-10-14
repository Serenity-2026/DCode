import { afterEach, expect, it, vi } from 'vitest'
import { startApplication } from '../../src/main/app/bootstrap'

const electron = vi.hoisted(() => ({
  app: { isPackaged: false, on: vi.fn(), setName: vi.fn(), setPath: vi.fn(), whenReady: vi.fn(), quit: vi.fn() },
  dialog: { showErrorBox: vi.fn() }
}))
vi.mock('electron', () => electron)
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks() })

it('catches asynchronous initialization failure and reports before quitting', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  electron.app.whenReady.mockRejectedValueOnce(new Error('初始化失败'))
  electron.app.quit.mockImplementationOnce(() => {
    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith('DCode 无法启动', '初始化失败')
  })
  await expect(startApplication()).resolves.toBeUndefined()
  expect(electron.dialog.showErrorBox).toHaveBeenCalledOnce()
  expect(electron.app.quit).toHaveBeenCalledOnce()
})

it('catches synchronous setup failure in the same startup try/catch', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubEnv('DCODE_USER_DATA_DIR', '/unused-test-path')
  electron.app.setPath.mockImplementationOnce(() => { throw new Error('用户目录无效') })
  await expect(startApplication()).resolves.toBeUndefined()
  expect(electron.app.whenReady).not.toHaveBeenCalled()
  expect(electron.dialog.showErrorBox).toHaveBeenCalledWith('DCode 无法启动', '用户目录无效')
  expect(electron.app.quit).toHaveBeenCalledOnce()
})
