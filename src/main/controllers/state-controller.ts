import { channels } from '../../shared/channels'
import { IpcRouter } from '../ipc/ipc-router'
import type { Action } from '../../shared/types'
import { StateService } from '../services/state-service'

/** 状态接口，依赖 StateService 提供公开快照及处理偏好、用户和会话操作。 */
export function registerStateController(router: IpcRouter, state: StateService): void {
  router.handle(channels.state, () => state.snapshot())
  router.handle<Action>(channels.action, input => router.exclusive(() => {
    state.apply(input)
    return state.snapshot()
  }))
}
