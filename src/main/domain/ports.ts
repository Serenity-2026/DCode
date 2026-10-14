import type { AttachmentSelection } from '../../shared/types'

/** Auth 与 Models 所需的秘密存储契约；生产由 Secrets 实现，单元测试注入隔离实现。 */
export interface SecretCodec {
  encrypt(value: string): Promise<string>
  decrypt(value: string): Promise<string>
}

/** DesktopService 使用的系统能力，生产由 ElectronDesktop 实现，使业务规则不依赖 Electron。 */
export interface DesktopAccess {
  selectAttachments(kind: 'file' | 'folder'): Promise<AttachmentSelection>
  copyText(text: string): void
  openLink(url: string): Promise<void>
}
