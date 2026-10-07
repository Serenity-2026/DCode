import { channels } from '../../shared/channels'
import { IpcRouter } from '../ipc/ipc-router'
import { DesktopService } from '../services/desktop-service'

/** 桌面接口，依赖 DesktopService 处理附件、复制和外链，控制器不访问系统 API。 */
export function registerDesktopController(router: IpcRouter, desktop: DesktopService): void {
  router.handle<'file' | 'folder'>(channels.selectAttachments, kind => router.exclusive(() => desktop.selectAttachments(kind)))
  router.handle<string>(channels.copyText, input => desktop.copyText(input))
  router.handle(channels.openLink, (input: unknown) => desktop.openLink(input))
}
