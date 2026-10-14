import type { SendInput, Snapshot } from '../../shared/types'
import type { ModelConfig } from '../domain/model-config'
import { AgentSession } from './agent-session'
import { StateService } from './state-service'

/** app 提供完整会话运行实例；管理器不负责装配模型、工具或系统资源。 */
export interface SessionRuntime { session: AgentSession; dispose(): void }

/** 按会话管理独立任务；依赖状态服务检查账号归属，工厂隔离 Agent 和工具上下文。 */
export class AgentSessions {
  private readonly sessions = new Map<string, SessionRuntime>()
  private stopping?: Promise<Snapshot>

  /** 注入实例工厂，只有会话第一次发送时才创建运行对象。 */
  constructor(private readonly store: StateService, private readonly create: () => SessionRuntime) {}

  /** 汇总运行状态，供调用方判断是否仍有任务未结束。 */
  get busy(): boolean { return [...this.sessions.values()].some(runtime => runtime.session.busy) }
  /** 会话级互斥和删除保护不受当前导航位置影响。 */
  isBusy(id: string): boolean { return this.sessions.get(id)?.session.busy || false }

  /** 对指定会话发送，null 创建新会话；不同会话使用各自运行实例。 */
  send(input: SendInput, config: ModelConfig): Snapshot {
    this.store.requireUser()
    if (this.stopping) throw new Error('正在停止任务，请稍后重试。')
    if (!input || typeof input !== 'object') throw new Error('无效请求。')
    const id = input.conversationId === undefined ? this.store.state.activeConversationId : input.conversationId
    if (id !== null) this.store.conversation(id)
    const existing = id ? this.sessions.get(id) : undefined
    const runtime = existing || this.create()
    try {
      const snapshot = runtime.session.send({ ...input, conversationId: id }, config)
      this.sessions.set(id || snapshot.activeConversationId!, runtime)
      return snapshot
    } catch (error) {
      if (!existing) runtime.dispose()
      throw error
    }
  }

  /** 只停止指定账号所属会话，其他任务继续执行。 */
  async stop(id: string): Promise<Snapshot> {
    this.store.conversation(id)
    const runtime = this.sessions.get(id)
    return runtime ? runtime.session.stop() : this.store.snapshot()
  }

  /** 关闭或退出前同时取消所有任务，等待所有会话保存；期间拒绝启动新任务。 */
  stopAll(): Promise<Snapshot> {
    if (this.stopping) return this.stopping
    const pending = Promise.allSettled([...this.sessions.values()].map(runtime => runtime.session.stop())).then(results => {
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason instanceof Error ? result.reason.message : '任务停止失败。'] : [])
      if (errors.length) throw new Error(errors.join('\n'))
      return this.store.snapshot()
    })
    this.stopping = pending
    const release = (): void => { if (this.stopping === pending) this.stopping = undefined }
    // 只释放共享停止标记；原 pending 的错误仍由停止、关闭或退出调用方接收。
    void pending.then(release, release)
    return pending
  }

  /** 删除会话前拒绝运行中的任务，并清理已空闲的工具资源。 */
  remove(id: string): void {
    this.store.conversation(id)
    if (this.isBusy(id)) throw new Error('请先停止这段对话的任务，再删除。')
    this.sessions.get(id)?.dispose()
    this.sessions.delete(id)
  }

  /** 应用退出时逐个清理独立运行资源，单个失败不阻止其他会话清理。 */
  dispose(): void {
    const errors: string[] = []
    for (const [id, runtime] of this.sessions) {
      try { runtime.dispose(); this.sessions.delete(id) }
      catch (error) { errors.push(error instanceof Error ? error.message : '资源清理失败。') }
    }
    if (errors.length) throw new Error(errors.join('\n'))
  }
}
