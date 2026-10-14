import type { AttachmentSelection } from '../../shared/types'

/** 脱离 IPC 的任务错误边界；应用统一捕获和报告，调用方只提供必要的失败状态恢复。 */
export interface ErrorBoundary {
  run(title: string, operation: () => void | Promise<unknown>, onFailure?: () => void): void
}

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
