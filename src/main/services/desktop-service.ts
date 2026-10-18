import type { AttachmentSelection, ProjectDraft, Snapshot } from '../../shared/types'
import type { DesktopAccess } from '../domain/ports'
import { textInput } from '../domain/validation'
import { StateService } from './state-service'

/** 桌面操作的业务入口，依赖 StateService 校验登录及 DesktopAccess 执行原生能力，不直接使用 Electron。
 * 相当于Java项目中的service层
 * */
export class DesktopService {
  private projectParent?: { userId: string; directory: string }
  /** 注入系统适配与当前账号状态，控制器仅调用这些受限业务方法。 */
  constructor(private store: StateService, private desktop: DesktopAccess) {}

  /** 只接受系统选择器或当前账号已有会话的目录；取消时不保存会话。 */
  async createConversation(sourceId?: string): Promise<Snapshot | null> {
    const userId = this.store.requireUser().id
    const directory = sourceId === undefined ? await this.desktop.selectDirectory() : this.store.conversation(sourceId).directory
    if (directory === null) return null
    await this.desktop.checkDirectory(directory)
    if (this.store.requireUser().id !== userId) throw new Error('登录状态已变化，请重试。')
    this.store.createConversation(directory)
    return this.store.snapshot()
  }

  /** 记录原生选择器授权的位置，创建时再次校验账号和路径。 */
  async selectProjectDirectory(): Promise<string | null> {
    const userId = this.store.requireUser().id
    const directory = await this.desktop.selectProjectDirectory()
    if (this.store.requireUser().id !== userId) throw new Error('登录状态已变化，请重试。')
    if (directory) this.projectParent = { userId, directory }
    return directory
  }

  /** 创建独立项目目录及首段空会话，防止项目名越过所选父目录。 */
  async createProject(input: ProjectDraft): Promise<Snapshot> {
    const userId = this.store.requireUser().id
    const name = textInput(input?.name, 80)
    if (/^[.]+$|[<>:"/\\|?*\u0000-\u001f]|[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('项目名不能包含路径或系统保留字符。')
    if (input.parentDirectory !== undefined) {
      if (this.projectParent?.userId !== userId || this.projectParent.directory !== input.parentDirectory) throw new Error('请先选择项目创建位置。')
      await this.desktop.checkDirectory(input.parentDirectory)
    }
    const directory = await this.desktop.createProject(name, input.parentDirectory)
    if (this.store.requireUser().id !== userId) throw new Error('登录状态已变化，请重试。')
    this.store.createConversation(directory)
    return this.store.snapshot()
  }

  /** 验证登录和附件类型，再由系统适配打开选择器并读取所选文本。 */
  selectAttachments(kind: 'file' | 'folder'): Promise<AttachmentSelection> {
    this.store.requireUser()
    if (kind !== 'file' && kind !== 'folder') throw new Error('无效附件类型。')
    return this.desktop.selectAttachments(kind)
  }

  /** 校验复制内容与登录状态，只允许写入文本，不向界面提供通用剪贴板权限。 */
  copyText(input: string): void {
    this.store.requireUser()
    if (typeof input !== 'string' || input.length > 1_000_000) throw new Error('复制内容无效或过长。')
    this.desktop.copyText(input)
  }

  /** 只允许没有内嵌凭据的 HTTP(S) 链接，由系统适配在外部浏览器打开。 */
  async openLink(input: unknown): Promise<void> {
    this.store.requireUser()
    if (typeof input !== 'string') throw new Error('链接无效。')
    const url = new URL(input)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('仅支持 HTTP 或 HTTPS 链接。')
    await this.desktop.openLink(url.toString())
  }
}
