import { randomUUID } from 'node:crypto'
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Action, Attachment, Conversation, Message, ProviderProfile, ReasoningEffort, Snapshot, Theme, User } from '../shared/types'
import { modelEfforts, reasoningEfforts, validateAttachments } from '../shared/context'
export { contextMessages } from '../shared/context'

/** 校验并去除文本两端空白，供 Store 的用户名称、会话标题和问题输入共用。 */
export function textInput(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new Error(`请输入 1–${max} 个字符。`)
  }
  return value.trim()
}

/** 仅在主进程保存的账号记录；Auth 管理密码与会话，Models 管理密钥密文。 */
export interface StoredUser extends User {
  passwordHash?: string
  passwordSalt?: string
  theme: Theme
  providers: (ProviderProfile & { encryptedApiKey: string })[]
  activeProviderId: string | null
  selectedModel: string | null
  fastMode: boolean
  reasoningEffort?: ReasoningEffort | null
}

/** 保持登录的令牌只以 OS 加密密文保存，Auth 在启动时解密并核对哈希。 */
export interface RememberedSession { userId: string; tokenHash: string; encryptedToken: string }

/** schema 3 的磁盘格式，不能直接通过 IPC 返回给界面。 */
export interface StoredState {
  schemaVersion: 3
  users: StoredUser[]
  activeUserId: string | null
  activeConversationId: string | null
  conversations: Conversation[]
  session: RememberedSession | null
}

/** schema 2 的旧服务记录，只用于 Store 升级，旧手填模型不会混入服务返回列表。 */
interface LegacyUser extends User {
  passwordHash?: string
  passwordSalt?: string
  theme: Theme
  models: { id: string; name: string; baseUrl: string; model: string; encryptedApiKey: string }[]
  activeModelId: string | null
}

/** 校验磁盘结构、唯一性及账号/会话归属，同时接受首版和 schema 2 用于无损升级。 */
function validState(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const state = value as StoredState
  const version = (value as { schemaVersion: number }).schemaVersion
  if (![1, 2, 3].includes(version) || !Array.isArray(state.users) || !Array.isArray(state.conversations)) return false
  if (version === 1 && !['light', 'dark'].includes((value as { theme: string }).theme)) return false
  const ids = new Set<string>()
  const usernames = new Set<string>()
  for (const u of state.users) {
    if (!u || typeof u.id !== 'string' || ids.has(u.id) || typeof u.name !== 'string' || !u.name.trim() || typeof u.createdAt !== 'string') return false
    ids.add(u.id)
    if (version >= 2) {
      if (!['light', 'dark'].includes(u.theme)) return false
      if (u.username !== undefined) {
        if (typeof u.username !== 'string' || typeof u.passwordHash !== 'string' || typeof u.passwordSalt !== 'string' || usernames.has(u.username)) return false
        usernames.add(u.username)
      }
      if (version === 2) {
        const old = u as unknown as LegacyUser
        if (!Array.isArray(old.models) || old.models.some(m => !m || ['id', 'name', 'baseUrl', 'model', 'encryptedApiKey'].some(key => typeof m[key as keyof typeof m] !== 'string'))) return false
        if (new Set(old.models.map(m => m.id)).size !== old.models.length || (old.activeModelId !== null && !old.models.some(m => m.id === old.activeModelId))) return false
      } else {
        if (!Array.isArray(u.providers) || typeof u.fastMode !== 'boolean') return false
        if (u.reasoningEffort != null && !reasoningEfforts.includes(u.reasoningEffort)) return false
        if (u.providers.some(p => !p || ['id', 'name', 'baseUrl', 'encryptedApiKey'].some(key => typeof p[key as keyof typeof p] !== 'string') || !Array.isArray(p.availableModels) || p.availableModels.some(id => typeof id !== 'string' || !id.trim()))) return false
        if (new Set(u.providers.map(p => p.id)).size !== u.providers.length) return false
        for (const provider of u.providers) if (provider.modelDetails !== undefined) {
          if (!provider.modelDetails || typeof provider.modelDetails !== 'object' || Array.isArray(provider.modelDetails)) return false
          if (Object.entries(provider.modelDetails).some(([id, detail]) => !provider.availableModels.includes(id) || !detail || typeof detail !== 'object' || (detail.contextWindow !== undefined && (!Number.isSafeInteger(detail.contextWindow) || detail.contextWindow <= 0)) || (detail.reasoningEfforts !== undefined && (!Array.isArray(detail.reasoningEfforts) || detail.reasoningEfforts.some(effort => !reasoningEfforts.includes(effort)))))) return false
        }
        if (u.activeProviderId !== null && !u.providers.some(p => p.id === u.activeProviderId)) return false
        if (u.selectedModel !== null && (typeof u.selectedModel !== 'string' || !u.providers.some(p => p.id === u.activeProviderId && p.availableModels.includes(u.selectedModel!)))) return false
      }
    }
  }
  const conversationIds = new Set<string>()
  for (const c of state.conversations) {
    if (!c || typeof c.id !== 'string' || conversationIds.has(c.id) || !ids.has(c.userId) || typeof c.title !== 'string' || typeof c.model !== 'string' || typeof c.createdAt !== 'string' || typeof c.updatedAt !== 'string' || !Array.isArray(c.messages)) return false
    conversationIds.add(c.id)
    if (c.messages.some(m => !m || typeof m.id !== 'string' || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || typeof m.reasoning !== 'string' || !['complete', 'streaming', 'stopped', 'error'].includes(m.status) || typeof m.createdAt !== 'string' || (m.error !== undefined && typeof m.error !== 'string'))) return false
    if (new Set(c.messages.map(m => m.id)).size !== c.messages.length) return false
    try { for (const message of c.messages) validateAttachments(message.attachments) } catch { return false }
  }
  if (state.activeUserId !== null && !ids.has(state.activeUserId)) return false
  if (state.activeConversationId !== null && !state.conversations.some(c => c.id === state.activeConversationId && c.userId === state.activeUserId)) return false
  if (version >= 2 && state.session !== null) {
    if (!state.session || !ids.has(state.session.userId) || typeof state.session.tokenHash !== 'string' || typeof state.session.encryptedToken !== 'string') return false
  }
  return true
}

/**
 * 主进程数据仓库，管理账号所属的会话、模型配置与主题；Auth 验证登录后才允许访问。
 * 依赖 shared/types 中的数据契约及 Node 文件系统/路径/UUID API，无需其他业务类；
 * Chat 调用它保存生成结果，主进程 IPC 调用它处理管理操作和获取界面快照。
 */
export class Store {
  state: StoredState
  private authenticatedUserId: string | null = null

  /**
   * 从指定 JSON 文件恢复状态；文件不存在时创建空账号状态，损坏时拒绝覆盖；升级前备份旧档案。
   * 将上次遗留的 streaming 消息标记为 stopped，再调用 save 保存恢复后的状态。
   */
  constructor(private readonly path: string) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (!validState(parsed)) throw new Error('Invalid state')
      if ((parsed as { schemaVersion: number }).schemaVersion === 1) {
        const legacy = parsed as { users: User[]; conversations: Conversation[]; theme: Theme }
        if (!existsSync(`${path}.v1.backup`)) copyFileSync(path, `${path}.v1.backup`, constants.COPYFILE_EXCL)
        this.state = {
          schemaVersion: 3, users: legacy.users.map(u => ({ ...u, theme: legacy.theme, providers: [], activeProviderId: null, selectedModel: null, fastMode: false })),
          activeUserId: null, activeConversationId: null, conversations: legacy.conversations, session: null
        }
      } else if ((parsed as { schemaVersion: number }).schemaVersion === 2) {
        const old = parsed as Omit<StoredState, 'schemaVersion' | 'users'> & { schemaVersion: 2; users: LegacyUser[] }
        if (!existsSync(`${path}.v2.backup`)) copyFileSync(path, `${path}.v2.backup`, constants.COPYFILE_EXCL)
        this.state = { ...old, schemaVersion: 3, users: old.users.map(({ models, activeModelId, ...user }) => ({
          ...user, providers: models.map(({ model: _oldModel, ...provider }) => ({ ...provider, availableModels: [] })),
          activeProviderId: activeModelId, selectedModel: null, fastMode: false
        })) }
      } else this.state = parsed as StoredState
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取本地数据，请备份数据文件后检查格式。')
      this.state = { schemaVersion: 3, users: [], activeUserId: null, activeConversationId: null, conversations: [], session: null }
    }
    for (const c of this.state.conversations) {
      for (const m of c.messages) if (m.status === 'streaming') m.status = 'stopped'
    }
    this.save()
  }

  /** 通过 Node 文件 API 先写入临时文件，再原子替换数据文件；失败时抛出保存错误。 */
  save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temp = `${this.path}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 })
      renameSync(temp, this.path)
    } catch {
      throw new Error('无法保存本地数据，请检查磁盘空间与文件权限。')
    }
  }

  /** 执行状态修改并调用 save；修改或保存失败时恢复原内存状态，供 apply 和 begin 使用。 */
  transaction<T>(update: () => T): T {
    const previous = structuredClone(this.state)
    const previousAuth = this.authenticatedUserId
    try {
      const result = update()
      this.save()
      return result
    } catch (error) {
      this.state = previous
      this.authenticatedUserId = previousAuth
      throw error
    }
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
      theme: user?.theme || 'light', legacyUsers: user ? [] : this.state.users.filter(u => !u.username).map(publicUser),
      providers: user?.providers.map(({ encryptedApiKey: _secret, ...profile }) => profile) || [],
      activeProviderId: user?.activeProviderId || null, selectedModel: user?.selectedModel || null, fastMode: user?.fastMode || false,
      reasoningEffort: user?.reasoningEffort || null,
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
          if (currentUser.reasoningEffort && !modelEfforts(currentUser.providers.find(p => p.id === action.providerId), action.model).includes(currentUser.reasoningEffort)) currentUser.reasoningEffort = null
          break
        case 'fast-mode':
          if (typeof action.enabled !== 'boolean') throw new Error('无效快速模式状态。')
          currentUser.fastMode = action.enabled
          break
        case 'reasoning-effort':
          if (action.effort !== null && (!reasoningEfforts.includes(action.effort) || !modelEfforts(currentUser.providers.find(p => p.id === currentUser.activeProviderId), currentUser.selectedModel).includes(action.effort))) throw new Error('该模型不支持此强度，请选择其他档位。')
          currentUser.reasoningEffort = action.effort
          break
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
