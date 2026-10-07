import { clipboard, dialog, shell, type BrowserWindow } from 'electron'
import type { AttachmentSelection } from '../../shared/types'
import type { DesktopAccess } from '../domain/ports'
import { readAttachments } from './attachments'

/** Electron 原生桌面适配，依赖当前窗口及附件读取器；业务校验由 DesktopService 完成。 */
export class ElectronDesktop implements DesktopAccess {
  /** 每次操作获取当前窗口，兼容 macOS 关闭后重新创建窗口。 */
  constructor(private getWindow: () => BrowserWindow | null) {}

  /** 使用父窗口的原生选择器；路径仅来自用户实际选择，不接收页面传入的任意路径。 */
  async selectAttachments(kind: 'file' | 'folder'): Promise<AttachmentSelection> {
    const result = await dialog.showOpenDialog(this.getWindow()!, {
      title: kind === 'file' ? '添加文件' : '添加文件夹',
      properties: kind === 'file' ? ['openFile', 'multiSelections'] : ['openDirectory']
    })
    return result.canceled ? { attachments: [], skipped: 0 } : readAttachments(result.filePaths, kind)
  }

  /** 将服务已校验的文本写入 Electron 剪贴板。 */
  copyText(text: string): void { clipboard.writeText(text) }

  /** 将服务已校验的链接交给系统默认浏览器。 */
  async openLink(url: string): Promise<void> { await shell.openExternal(url) }
}
