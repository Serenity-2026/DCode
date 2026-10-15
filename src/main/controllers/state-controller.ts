import { channels } from '../../shared/channels'
import { IpcRouter } from '../ipc/ipc-router'
import type { Action } from '../../shared/types'
import { StateService } from '../services/state-service'
import { AgentSessions } from '../services/agent-sessions'

/** 状态接口，依赖 StateService 提供公开快照及处理偏好、用户和会话操作。 */
export function registerStateController(router: IpcRouter, state: StateService, sessions: AgentSessions): void {
  router.handle(channels.state, () => state.snapshot())
  router.handle<Action>(channels.action, input => router.exclusive(() => {
    if (input?.type === 'conversation:delete') sessions.remove(input.id)
    if (input?.type === 'folder:delete') sessions.removeFolder(input.id)
    state.apply(input)
    return state.snapshot()
  }))
}
