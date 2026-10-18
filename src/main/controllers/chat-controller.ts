import { channels } from '../../shared/channels'
import { IpcRouter } from '../ipc/ipc-router'
import type { SendInput } from '../../shared/types'
import { AgentSessions } from '../agent/agent-sessions'
import { Models } from '../services/model-service'
import { StateService } from '../services/state-service'

/** 聊天接口，Models 提供本次配置，AgentSession 管理生成；停止接口不使用互斥锁。 */
export function registerChatController(router: IpcRouter, sessions: AgentSessions, models: Models, state: StateService): void {
  router.handle<SendInput>(channels.send, input => router.exclusive(async () => sessions.send(input, await models.selected())))
  router.handle<string>(channels.stop, id => { state.requireUser(); return sessions.stop(id) })
}
