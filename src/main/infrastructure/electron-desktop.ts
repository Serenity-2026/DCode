import { app, clipboard, dialog, shell, type BrowserWindow } from 'electron'
import { randomInt } from 'node:crypto'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AttachmentSelection } from '../../shared/types'
import type { DesktopAccess } from '../domain/ports'
import { readAttachments } from './attachments'

/** Electron 原生桌面适配，依赖当前窗口及附件读取器；业务校验由 DesktopService 完成。 */
export class ElectronDesktop implements DesktopAccess {
  /** 每次操作获取当前窗口，兼容 macOS 关闭后重新创建窗口。 */
  constructor(private getWindow: () => BrowserWindow | null) {}

  /** 新会话优先使用用户选择；取消时创建带应用名、当地日期和随机数的独立目录。 */
  async selectDirectory(): Promise<string> {
    const result = await dialog.showOpenDialog(this.getWindow()!, { title: '选择工作文件夹', properties: ['openDirectory', 'createDirectory'] })
    if (!result.canceled && result.filePaths[0]) return realpath(result.filePaths[0])
    const root = join(app.getPath('userData'), 'workspaces')
    await mkdir(root, { recursive: true })
    const now = new Date()
    const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    const directory = join(root, `dcode-${date}-${randomInt(100000000000, 1000000000000)}`)
    await mkdir(directory)
    return realpath(directory)
  }

  /** 选择项目父目录；取消不生成目录，也不影响当前会话。 */
  async selectProjectDirectory(): Promise<string | null> {
    const result = await dialog.showOpenDialog(this.getWindow()!, { title: '选择项目创建位置', properties: ['openDirectory', 'createDirectory'] })
    return result.canceled || !result.filePaths[0] ? null : realpath(result.filePaths[0])
  }

  /** 在已授权位置独占创建同名项目，拒绝覆盖已有目录或文件。 */
  async createProject(name: string, parentDirectory?: string): Promise<string> {
    const root = parentDirectory || join(app.getPath('userData'), 'workspaces')
    if (!parentDirectory) await mkdir(root, { recursive: true })
    const directory = join(root, name)
    try { await mkdir(directory) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('同名项目已存在，请更换项目名。')
      throw error
    }
    return realpath(directory)
  }

  /** 复用目录前确认仍为有效文件夹，失败不创建会话。 */
  async checkDirectory(directory: string): Promise<void> {
    if (!await stat(directory).then(info => info.isDirectory()).catch(() => false)) throw new Error('工作文件夹不存在或无法访问，请重新选择。')
  }

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
