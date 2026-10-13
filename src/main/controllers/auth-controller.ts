import { channels } from '../../shared/channels'
import { IpcRouter } from '../ipc/ipc-router'
import type { AuthInput } from '../../shared/types'
import { Auth } from '../services/auth-service'
import { AgentSessions } from '../services/agent-sessions'

/** 账号接口，将登录、注册与注销交给 Auth；互斥由 IpcRouter 管理。 */
export function registerAuthController(router: IpcRouter, auth: Auth, sessions: AgentSessions): void {
  router.handle<AuthInput>(channels.register, input => router.exclusive(() => auth.register(input)))
  router.handle<AuthInput>(channels.login, input => router.exclusive(() => auth.login(input)))
  router.handle(channels.logout, () => router.exclusive(async () => { await sessions.stopAll(); return auth.logout() }))
}
