import type { Snapshot, StreamEvent } from '../shared/types'
import type { ModelConfig } from './config'
import { streamModel } from './model'
import { contextMessages, Store } from './store'

export class Chat {
  private active?: { controller: AbortController; done: Promise<void> }

  constructor(private store: Store, private config: ModelConfig, private emit: (event: StreamEvent) => void) {}

  get busy(): boolean { return Boolean(this.active) }

  send(input: { content: string; retry?: boolean }): Snapshot {
    if (this.busy) throw new Error('请先停止当前生成。')
    if (!input || typeof input !== 'object' || (input.retry !== undefined && typeof input.retry !== 'boolean')) throw new Error('无效请求。')
    if (!this.config.apiKey) throw new Error('请在环境变量中配置 DEEPSEEK_API_KEY，然后重启应用。')
    const { conversation, message } = this.store.begin(input.content, Boolean(input.retry), this.config.model)
    const controller = new AbortController()
    // 延迟到 invoke 响应之后发事件，同时允许 stop 在请求开始前取消。
    const done = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      let lastSave = Date.now()
      let lastEmit = 0
      try {
        await streamModel(this.config, contextMessages(conversation), controller, delta => {
          message.content += delta.content || ''
          message.reasoning += delta.reasoning || ''
          if (Date.now() - lastSave >= 500) { this.store.save(); lastSave = Date.now() }
          if (Date.now() - lastEmit >= 30) {
            this.emit({ conversationId: conversation.id, message: structuredClone(message) })
            lastEmit = Date.now()
          }
        })
        if (!message.content.trim()) throw new Error('模型没有返回文本，请重试。')
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
    return this.store.snapshot(this.config)
  }

  async stop(): Promise<Snapshot> {
    const active = this.active
    if (active) { active.controller.abort(); await active.done }
    return this.store.snapshot(this.config)
  }
}
