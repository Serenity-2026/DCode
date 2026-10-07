import type { AttachmentSelection } from '../../shared/types'
import type { DesktopAccess } from '../domain/ports'
import { StateService } from './state-service'

/** 桌面操作的业务入口，依赖 StateService 校验登录及 DesktopAccess 执行原生能力，不直接使用 Electron。 */
export class DesktopService {
  /** 注入系统适配与当前账号状态，控制器仅调用这些受限业务方法。 */
  constructor(private store: StateService, private desktop: DesktopAccess) {}

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
