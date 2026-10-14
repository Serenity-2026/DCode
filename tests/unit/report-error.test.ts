import { afterEach, expect, it, vi } from 'vitest'
import { reportError } from '../../src/main/app/report-error'

const showError = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ dialog: { showErrorBox: showError } }))
afterEach(() => { vi.restoreAllMocks(); showError.mockReset() })

it('records the original exception and shows its message', () => {
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  const cause = new Error('磁盘已满')
  reportError('任务停止失败', cause)
  expect(diagnostic).toHaveBeenCalledWith('任务停止失败', cause)
  expect(showError).toHaveBeenCalledWith('任务停止失败', cause.message)
})

it('keeps a diagnostic when the native error dialog itself throws', () => {
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  const cause = new Error('原生提示失败')
  showError.mockImplementation(() => { throw cause })
  expect(() => reportError('后台任务失败', new Error('保存失败'))).not.toThrow()
  expect(diagnostic).toHaveBeenCalledWith('错误提示失败', cause)
  expect(showError).toHaveBeenCalledOnce()
})

it('handles non-Error rejection values', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  reportError('任务失败', undefined)
  expect(showError).toHaveBeenCalledWith('任务失败', '操作失败，请重试。')
})
