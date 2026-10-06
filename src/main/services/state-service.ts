import { randomUUID } from 'node:crypto'
import type { Action, Attachment, Conversation, Message, ProviderProfile, Snapshot, User } from '../../shared/types'
import { modelEfforts, resolveEffort, selectedEffort, validateAttachments } from '../../shared/context'
import type { StoredState, StoredUser } from '../domain/state'
import { textInput } from '../domain/validation'
import { StateRepository } from '../repositories/state-repository'

/** 管理认证身份、账号隔离、偏好、会话及公开快照；依赖 StateRepository 保存数据，Auth/Models/Chat 调用业务方法。 */
export class StateService {
  /** 返回仓库内业务数据引用，仅供主进程服务使用，界面只能取得 snapshot。 */
  get state(): StoredState { return this.repository.state }
  private authenticatedUserId: string | null = null

  /** 注入 StateRepository；修正模型偏好和上次中断的消息，再保存恢复结果，不直接访问文件系统。 */
  constructor(private readonly repository: StateRepository) {
    for (const user of this.state.users) {
      for (const profile of user.providers) this.reconcileEfforts(profile)
    }
    for (const conversation of this.state.conversations) {
      for (const message of conversation.messages) if (message.status === 'streaming') message.status = 'stopped'
    }
    this.save()
  }

  /** 模型目录更新及启动读取时修正失效档位；依赖共享规则，不修改其他模型和账号的选择。 */
  reconcileEfforts(provider: ProviderProfile): void {
    for (const [model, value] of Object.entries(provider.selectedEfforts || {})) {
      const detail = provider.modelDetails?.[model]
      if (detail?.reasoningEfforts === undefined) continue
      const effort = resolveEffort(value, detail)
      if (effort) provider.selectedEfforts![model] = effort
      else delete provider.selectedEfforts![model]
    }
  }

  /** 将当前业务状态交给 StateRepository 原子保存，Chat 用它周期性保存流式内容。 */
  save(): void { this.repository.save() }

  /** 由仓库回滚数据，服务同时回滚认证身份，保证账号与会话修改在同一事务内。 */
  transaction<T>(update: () => T): T {
    const previousAuth = this.authenticatedUserId
    try { return this.repository.transaction(update) }
    catch (error) { this.authenticatedUserId = previousAuth; throw error }
  }

  /** Auth 完成密码/会话验证后调用，保持相同账号的最后会话选择。 */
  authenticate(id: string): void {
    const user = this.state.users.find(u => u.id === id && u.username && u.passwordHash)
    if (!user) throw new Error('账号不存在。')
    this.authenticatedUserId = id
    this.state.activeUserId = id
    if (!this.state.conversations.some(c => c.id === this.state.activeConversationId && c.userId === id)) this.state.activeConversationId = null
  }

  /** 撤销运行时登录身份；仅持久化 activeUserId 不能绕过此校验。 */
  clearAuthentication(): void {
    this.authenticatedUserId = null
    this.state.activeUserId = null
    this.state.activeConversationId = null
  }

  /** 主进程业务入口的登录校验，返回当前账号内部记录，不能经 IPC 暴露。 */
  requireUser(): StoredUser {
    const user = this.state.users.find(u => u.id === this.authenticatedUserId && u.id === this.state.activeUserId)
    if (!user) throw new Error('请先登录。')
    return user
  }

  /** 只返回当前已验证账号的公开数据，未登录时隐藏聊天、模型、密码与会话秘密。 */
  snapshot(): Snapshot {
    const user = this.state.users.find(u => u.id === this.authenticatedUserId && u.id === this.state.activeUserId)
    const publicUser = (u: User): User => ({ id: u.id, name: u.name, username: u.username, createdAt: u.createdAt })
    const selected = user?.providers.find(p => p.id === user.activeProviderId)
    return structuredClone({
      users: user ? [publicUser(user)] : [], activeUserId: user?.id || null,
      activeConversationId: user ? this.state.activeConversationId : null,
      conversations: user ? this.state.conversations.filter(c => c.userId === user.id) : [],
      theme: user?.theme || 'light',
      providers: user?.providers.map(({ encryptedApiKey: _secret, ...profile }) => profile) || [],
      activeProviderId: user?.activeProviderId || null, selectedModel: user?.selectedModel || null, fastMode: user?.fastMode || false,
      reasoningEffort: selectedEffort(selected, user?.selectedModel || null),
      config: { baseUrl: selected?.baseUrl || '', model: user?.selectedModel || '', configured: Boolean(selected?.encryptedApiKey && selected.availableModels.includes(user?.selectedModel || '')) }
    })
  }

  /** 按 ID 查找当前用户所属的会话；不存在或属于其他用户时拒绝访问。 */
  conversation(id: unknown): Conversation {
    const user = this.requireUser()
    const c = this.state.conversations.find(c => c.id === id && c.userId === user.id)
    if (!c) throw new Error('会话不存在。')
    return c
  }

  /**
   * 处理 IPC 的 Action：当前账号改名、会话管理、模型切换与账号主题修改。
   * 依赖 transaction 保证失败回滚，textInput 校验文本，conversation 检查会话归属。
   */
  apply(action: Action): void {
    const currentUser = this.requireUser()
    if (!action || typeof action !== 'object') throw new Error('无效操作。')
    this.transaction(() => {
      switch (action.type) {
        case 'user:rename':
          if (action.id !== currentUser.id) throw new Error('无权修改其他账号。')
          currentUser.name = textInput(action.name, 40)
          break
        case 'model:select':
          if (!currentUser.providers.some(p => p.id === action.providerId && p.availableModels.includes(action.model))) throw new Error('模型不存在或不属于当前账号。')
          currentUser.activeProviderId = action.providerId
          currentUser.selectedModel = action.model
          break
        case 'fast-mode':
          if (typeof action.enabled !== 'boolean') throw new Error('无效快速模式状态。')
          currentUser.fastMode = action.enabled
          break
        case 'reasoning-effort': {
          const provider = currentUser.providers.find(item => item.id === currentUser.activeProviderId)
          const model = currentUser.selectedModel
          if (!provider || !model || !action.effort || !modelEfforts(provider.modelDetails?.[model]).includes(action.effort)) throw new Error('该模型不支持此强度，请选择模型提供的档位。')
          provider.selectedEfforts = { ...provider.selectedEfforts, [model]: action.effort }
          break
        }
        case 'conversation:select':
          if (action.id !== null) this.conversation(action.id)
          this.state.activeConversationId = action.id
          break
        case 'conversation:rename':
          this.conversation(action.id).title = textInput(action.title, 80)
          break
        case 'conversation:delete':
          this.conversation(action.id)
          this.state.conversations = this.state.conversations.filter(c => c.id !== action.id)
          if (this.state.activeConversationId === action.id) this.state.activeConversationId = null
          break
        case 'theme':
          if (!['light', 'dark'].includes(action.theme)) throw new Error('无效主题。')
          currentUser.theme = action.theme
          break
        default: throw new Error('无效操作。')
      }
    })
  }

  /**
   * 为 Chat.send 准备一次生成：校验附件快照，必要时新建会话，保存问题并添加 streaming 回复占位。
   * 重试时只替换最后的 assistant 消息；返回仓库内对象的引用，供 Chat 持续追加文本。
   */
  begin(content: unknown, retry: boolean, model: string, inputAttachments?: Attachment[]): { conversation: Conversation; message: Message } {
    const user = this.requireUser()
    const attachments = retry ? [] : validateAttachments(inputAttachments)
    return this.transaction(() => {
      let c = this.state.activeConversationId ? this.conversation(this.state.activeConversationId) : undefined
      if (retry) {
        if (!c || c.messages.at(-1)?.role !== 'assistant' || c.messages.at(-2)?.role !== 'user') throw new Error('没有可重新生成的回复。')
        c.messages.pop()
      } else {
        const text = attachments.length && content === '' ? '' : textInput(content, 32_000)
        if (!c) {
          const now = new Date().toISOString()
          c = { id: randomUUID(), userId: user.id, title: (text || attachments[0].name).replace(/\s+/g, ' ').slice(0, 32), model, createdAt: now, updatedAt: now, messages: [] }
          this.state.conversations.push(c)
          this.state.activeConversationId = c.id
        }
        c.messages.push({ id: randomUUID(), role: 'user', content: text, reasoning: '', status: 'complete', createdAt: new Date().toISOString(), ...(attachments.length ? { attachments: structuredClone(attachments) } : {}) })
      }
      c!.model = model
      c!.updatedAt = new Date().toISOString()
      const message: Message = { id: randomUUID(), role: 'assistant', content: '', reasoning: '', status: 'streaming', createdAt: new Date().toISOString() }
      c!.messages.push(message)
      return { conversation: c!, message }
    })
  }
}
