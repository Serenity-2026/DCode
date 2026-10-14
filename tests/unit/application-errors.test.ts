import { afterEach, expect, it, vi } from 'vitest'
import { ApplicationErrors } from '../../src/main/app/application-errors'

const showError = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ dialog: { showErrorBox: showError } }))
afterEach(() => { vi.restoreAllMocks(); showError.mockReset() })

it.each(['sync', 'async'])('reports %s failures through the same application policy', async mode => {
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  const errors = new ApplicationErrors()
  const cause = new Error('磁盘已满')
  const recover = vi.fn()
  errors.run('任务停止失败', () => {
    if (mode === 'sync') throw cause
    return Promise.reject(cause)
  }, recover)
  await vi.waitFor(() => expect(showError).toHaveBeenCalledOnce())
  expect(showError).toHaveBeenCalledWith('任务停止失败', '磁盘已满')
  expect(diagnostic).toHaveBeenCalledWith('任务停止失败', cause)
  expect(recover).toHaveBeenCalledOnce()
})

it('keeps successful operations silent and does not run failure recovery', async () => {
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  const recover = vi.fn()
  const errors = new ApplicationErrors()
  errors.run('同步任务', () => {}, recover)
  errors.run('异步任务', async () => {}, recover)
  await Promise.resolve()
  expect(recover).not.toHaveBeenCalled()
  expect(showError).not.toHaveBeenCalled()
  expect(diagnostic).not.toHaveBeenCalled()
})

it('finishes reporting a startup failure before requesting application quit', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const quit = vi.fn(() => { expect(showError).toHaveBeenCalledWith('无法启动', '配置损坏') })
  new ApplicationErrors().run('无法启动', () => { throw new Error('配置损坏') }, quit)
  expect(quit).toHaveBeenCalledOnce()
  expect(showError).toHaveBeenCalledOnce()
})

it('contains native reporting failure at the top level', async () => {
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  const reportError = new Error('原生提示失败')
  showError.mockImplementation(() => { throw reportError })
  const recover = vi.fn()
  new ApplicationErrors().run('后台任务失败', () => Promise.reject(new Error('保存失败')), recover)
  await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledWith('错误提示失败', reportError))
  expect(recover).toHaveBeenCalledOnce()
  expect(showError).toHaveBeenCalledOnce()
})

it('preserves the original error when failure recovery also fails', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  new ApplicationErrors().run('退出失败', () => { throw new Error('保存失败') }, () => { throw new Error('恢复失败') })
  expect(showError).toHaveBeenCalledWith('退出失败', '保存失败\n失败恢复异常：恢复失败')
})

it('handles non-Error rejection values without throwing from the reporter', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  new ApplicationErrors().run('任务失败', () => Promise.reject(undefined))
  await vi.waitFor(() => expect(showError).toHaveBeenCalledWith('任务失败', '操作失败，请重试。'))
})
