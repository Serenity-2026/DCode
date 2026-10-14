import { dialog } from 'electron'

/** 应用统一错误报告：记录原始异常并提示；原生提示自身失败时仅记录诊断。 */
export function reportError(title: string, error: unknown): void {
  console.error(title, error)
  try { dialog.showErrorBox(title, error instanceof Error ? error.message : '操作失败，请重试。') }
  catch (reportError) { console.error('错误提示失败', reportError) }
}
