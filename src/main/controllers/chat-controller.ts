import { channels } from '../../shared/channels'
import { IpcRouter } from '../ipc/ipc-router'
import type { SendInput } from '../../shared/types'
import { Chat } from '../services/chat-service'
import { Models } from '../services/model-service'
import { StateService } from '../services/state-service'

/** 聊天接口，Models 提供本次配置，Chat 管理生成；停止接口不使用互斥锁。 */
export function registerChatController(router: IpcRouter, chat: Chat, models: Models, state: StateService): void {
  router.handle<SendInput>(channels.send, input => router.exclusive(async () => chat.send(input, await models.selected())))
  router.handle(channels.stop, () => { state.requireUser(); return chat.stop() })
}
