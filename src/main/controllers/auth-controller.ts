import { channels } from '../../shared/channels'
import { IpcRouter } from '../ipc/ipc-router'
import type { AuthInput } from '../../shared/types'
import { Auth } from '../services/auth-service'

/** 账号接口，将登录、注册与注销交给 Auth；互斥由 IpcRouter 管理。 */
export function registerAuthController(router: IpcRouter, auth: Auth): void {
  router.handle<AuthInput>(channels.register, input => router.exclusive(() => auth.register(input)))
  router.handle<AuthInput>(channels.login, input => router.exclusive(() => auth.login(input)))
  router.handle(channels.logout, () => router.exclusive(() => auth.logout()))
}
