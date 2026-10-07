import { ipcMain, type BrowserWindow } from 'electron'
import type { Result } from '../../shared/types'

/** IPC 传输入口，依赖当前窗口和生成状态回调；统一验证调用来源、包装结果，并阻止互斥操作交错。 */
export class IpcRouter {
  private operationBusy = false

  /** 装配层提供窗口及忙碌状态，不在 Router 中持有业务服务或仓库。 */
  constructor(private getWindow: () => BrowserWindow | null, private isGenerating: () => boolean) {}

  /** 注册一个请求接口，只接受当前窗口主 frame；业务异常统一转换为 Result。 */
  handle<T = void>(channel: string, handler: (input: T) => unknown): void {
    ipcMain.handle(channel, async (event, input): Promise<Result<unknown>> => {
      try {
        const window = this.getWindow()
        if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无权执行此操作。')
        return { ok: true, value: await handler(input) }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : '操作失败。' }
      }
    })
  }

  /** 拒绝正在生成或已有操作期间的新修改，失败后也释放标记；停止生成接口直接 handle，避免被锁阻止。 */
  async exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.operationBusy || this.isGenerating()) throw new Error('请等待当前操作完成，或先停止生成。')
    this.operationBusy = true
    try { return await operation() } finally { this.operationBusy = false }
  }
}
