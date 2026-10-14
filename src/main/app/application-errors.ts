import { dialog } from 'electron'
import type { ErrorBoundary } from '../domain/ports'

/** 应用级错误入口：统一处理生命周期和后台任务异常、诊断日志及原生错误提示。 */
export class ApplicationErrors implements ErrorBoundary {
  /** 同时捕获同步异常和异步拒绝；报告后执行失败恢复，保证启动失败提示在退出前完成。 */
  run(title: string, operation: () => void | Promise<unknown>, onFailure?: () => void): void {
    const fail = (cause: unknown): void => {
      this.report(title, cause)
      try { onFailure?.() } catch (recoveryError) {
        this.report(title, new AggregateError([cause, recoveryError], `${cause instanceof Error ? cause.message : '操作失败。'}\n失败恢复异常：${recoveryError instanceof Error ? recoveryError.message : '无法恢复状态。'}`))
      }
    }
    try {
      const pending = operation()
      if (pending) void pending.catch(fail)
    } catch (error) { fail(error) }
  }

  /** 统一记录原始错误并提示；原生提示自身失败时仅记录诊断，不再次弹框。 */
  private report(title: string, error: unknown): void {
    console.error(title, error)
    try { dialog.showErrorBox(title, error instanceof Error ? error.message : '操作失败，请重试。') }
    catch (reportError) { console.error('错误提示失败', reportError) }
  }
}
