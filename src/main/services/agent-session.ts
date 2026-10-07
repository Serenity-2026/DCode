import type { Conversation, Message, SendInput, Snapshot, StreamEvent } from '../../shared/types'
import { contextMessages } from '../../shared/context'
import type { AgentEvent } from '../domain/agent'
import { toLlmMessages, type LlmMessage } from '../domain/llm'
import type { ModelConfig } from '../domain/model-config'
import { Agent } from './agent'
import { StateService } from './state-service'

/** 应用会话层：准备上下文、保存正文和推送界面；运行控制由独立 Agent 负责。 */
export class AgentSession {
  //表示这次生成对应哪一个会话、哪一条 assistant 占位消息，以及上次保存、推送的时间。
  private target?: { conversation: Conversation; message: Message; lastSave: number; lastEmit: number }

  /** 订阅 Agent 事件，生命周期与应用实例一致，不持有模型或取消控制器。 */
  constructor(private store: StateService, private emit: (event: StreamEvent) => void, private readonly agent: Agent) {
    //Agent 有事件时，调用该函数；这个函数再把事件交给 onEvent() 处理。
    this.agent.subscribe(event => this.onEvent(event))
  }

  /** 等待终止事件完成保存之前，IPC 与窗口都继续视为忙碌。 */
  get busy(): boolean { return this.agent.busy }

  /** 创建回复占位，替换为当前会话成功历史，再把本次问题交给 Agent。 */
  send(input: SendInput, config: ModelConfig): Snapshot {
    this.store.requireUser()
    if (this.busy) throw new Error('请先停止当前生成。')
    if (!input || typeof input !== 'object' || (input.retry !== undefined && typeof input.retry !== 'boolean')) throw new Error('无效请求。')
    if (!config.apiKey) throw new Error('请先配置模型 API 密钥。')
    const { conversation, message } = this.store.begin(input.content, Boolean(input.retry), config.model, input.attachments)
    const context = toLlmMessages(contextMessages(conversation))
    const prompt = context.pop() as Extract<LlmMessage, { role: 'user' }>
    this.agent.replaceMessages(context)
    this.target = { conversation, message, lastSave: Date.now(), lastEmit: 0 }
    // 运行错误由 agent_end 保存；终止订阅者抛错时也避免产生未处理的 Promise。
    void this.agent.prompt(config, prompt).catch(() => {})
    return this.store.snapshot()
  }

  /** 取消并等待 Agent 终止事件保存完成，再向界面返回最终快照。 */
  async stop(): Promise<Snapshot> {
    this.agent.abort()
    await this.agent.waitForIdle()
    return this.store.snapshot()
  }

  /** 将运行时事件投影为现有会话格式；完整工具上下文由 Agent 保留。 */
  private onEvent(event: AgentEvent): void {
    const target = this.target
    if (!target) return
    const { conversation, message } = target
    if (event.type === 'message_update') {
      message.content += event.delta.content || ''
      message.reasoning += event.delta.reasoning || ''
      if (Date.now() - target.lastSave >= 500) { this.store.save(); target.lastSave = Date.now() }
      if (Date.now() - target.lastEmit >= 30) {
        this.emit({ conversationId: conversation.id, message: structuredClone(message) })
        target.lastEmit = Date.now()
      }
    } else if (event.type === 'agent_end') {
      message.status = event.outcome
      if (event.error) message.error = event.error
      conversation.updatedAt = new Date().toISOString()
      try { this.store.save() } catch (error) {
        message.status = 'error'
        message.error = error instanceof Error ? error.message : '保存失败。'
      }
      this.target = undefined
      this.emit({ conversationId: conversation.id, message: structuredClone(message) })
    }
  }
}
