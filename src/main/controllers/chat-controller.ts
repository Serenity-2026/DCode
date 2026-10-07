import { channels } from '../../shared/channels'
import { IpcRouter } from '../ipc/ipc-router'
import type { SendInput } from '../../shared/types'
import { AgentSession } from '../services/agent-session'
import { Models } from '../services/model-service'
import { StateService } from '../services/state-service'

/** 聊天接口，Models 提供本次配置，AgentSession 管理生成；停止接口不使用互斥锁。 */
export function registerChatController(router: IpcRouter, session: AgentSession, models: Models, state: StateService): void {
  router.handle<SendInput>(channels.send, input => router.exclusive(async () => session.send(input, await models.selected())))
  router.handle(channels.stop, () => { state.requireUser(); return session.stop() })
}
