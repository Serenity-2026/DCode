import type { SendInput, Snapshot, StreamEvent } from '../../shared/types'
import type { ModelConfig } from '../domain/model-config'
import { toLlmMessages } from '../domain/llm'
import { AgentLoop } from './agent-loop'
import { contextMessages } from '../../shared/context'
import { StateService } from './state-service'

/**
 * 管理一次对话生成的完整生命周期：发送、接收增量、保存结果和停止。
 * 依赖 StateService 管理会话，contextMessages 构建上下文，AgentLoop 调度模型与工具；
 * 主进程为每次请求传入当前账号选中的 ModelConfig，emit 将 StreamEvent 转发给界面。
 */
export class Chat {
  private active?: { controller: AbortController; done: Promise<void> }

  /** 注入状态、事件发送与循环服务；模型配置在每次发送时提供。 */
  constructor(private store: StateService, private emit: (event: StreamEvent) => void, private readonly agent: AgentLoop) {}

  /** 判断是否仍有未结束的生成任务，供主进程阻止并发操作及等待安全退出。 */
  get busy(): boolean { return Boolean(this.active) }

  /**
   * 通过 StateService.begin 保存问题与回复占位，启动 AgentLoop 后立即返回界面快照。
   * 后续文本通过 emit 推送；结束、失败或停止时保存最终状态。retry 会替换最后一条回复。
   */
  send(input: SendInput, config: ModelConfig): Snapshot {
    this.store.requireUser()
    if (this.busy) throw new Error('请先停止当前生成。')
    if (!input || typeof input !== 'object' || (input.retry !== undefined && typeof input.retry !== 'boolean')) throw new Error('无效请求。')
    if (!config.apiKey) throw new Error('请先配置模型 API 密钥。')
    const { conversation, message } = this.store.begin(input.content, Boolean(input.retry), config.model, input.attachments)
    const controller = new AbortController()
    // 延迟到 invoke 响应之后发事件，同时允许 stop 在请求开始前取消。
    const done = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      let lastSave = Date.now()
      let lastEmit = 0
      try {
        await this.agent.run(config, toLlmMessages(contextMessages(conversation)), controller, delta => {
          message.content += delta.content || ''
          message.reasoning += delta.reasoning || ''
          if (Date.now() - lastSave >= 500) { this.store.save(); lastSave = Date.now() }
          if (Date.now() - lastEmit >= 30) {
            this.emit({ conversationId: conversation.id, message: structuredClone(message) })
            lastEmit = Date.now()
          }
        })
        message.status = 'complete'
      } catch (error) {
        message.status = controller.signal.aborted && !(error instanceof Error && error.message.includes('超时')) ? 'stopped' : 'error'
        if (message.status === 'error') message.error = error instanceof Error ? error.message : '生成失败，请重试。'
      } finally {
        conversation.updatedAt = new Date().toISOString()
        try { this.store.save() } catch (error) {
          message.status = 'error'
          message.error = error instanceof Error ? error.message : '保存失败。'
        }
        this.active = undefined
        this.emit({ conversationId: conversation.id, message: structuredClone(message) })
      }
    })
    this.active = { controller, done }
    return this.store.snapshot()
  }

  /** 使用 AbortController 取消请求，等待生成任务保存收尾后返回 StateService 的最新快照。 */
  async stop(): Promise<Snapshot> {
    const active = this.active
    if (active) { active.controller.abort(); await active.done }
    return this.store.snapshot()
  }
}
