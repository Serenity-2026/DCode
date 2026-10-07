import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { StoredState } from '../domain/state'
import { reasoningEfforts, validateAttachments } from '../../shared/context'
import { modelApis } from '../../shared/model-api'

/** 校验当前磁盘结构、唯一性及账号/会话归属，不转换其他版本的数据。 */
function validState(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const state = value as StoredState
  if (state.schemaVersion !== 3 || !Array.isArray(state.users) || !Array.isArray(state.conversations)) return false
  const ids = new Set<string>()
  const usernames = new Set<string>()
  for (const u of state.users) {
    if (!u || typeof u.id !== 'string' || ids.has(u.id) || typeof u.name !== 'string' || !u.name.trim() || typeof u.createdAt !== 'string') return false
    ids.add(u.id)
    if (!['light', 'dark'].includes(u.theme)) return false
    if (typeof u.username !== 'string' || typeof u.passwordHash !== 'string' || typeof u.passwordSalt !== 'string' || usernames.has(u.username)) return false
    usernames.add(u.username)
    if (!Array.isArray(u.providers) || typeof u.fastMode !== 'boolean') return false
    if (u.providers.some(p => !p || ['id', 'name', 'baseUrl', 'encryptedApiKey'].some(key => typeof p[key as keyof typeof p] !== 'string') || !Array.isArray(p.availableModels) || p.availableModels.some(id => typeof id !== 'string' || !id.trim()))) return false
    if (u.providers.some(p => p.selectedEfforts !== undefined && (!p.selectedEfforts || typeof p.selectedEfforts !== 'object' || Array.isArray(p.selectedEfforts) || Object.values(p.selectedEfforts).some(level => !reasoningEfforts.includes(level))))) return false
    if (new Set(u.providers.map(p => p.id)).size !== u.providers.length) return false
    if (u.providers.some(p => p.api !== undefined && !modelApis.includes(p.api))) return false
    for (const provider of u.providers) if (provider.modelDetails !== undefined) {
      if (!provider.modelDetails || typeof provider.modelDetails !== 'object' || Array.isArray(provider.modelDetails)) return false
      if (Object.entries(provider.modelDetails).some(([id, detail]) => !provider.availableModels.includes(id) || !detail || typeof detail !== 'object' || (detail.contextWindow !== undefined && (!Number.isSafeInteger(detail.contextWindow) || detail.contextWindow <= 0)) || (detail.defaultEffort !== undefined && !reasoningEfforts.includes(detail.defaultEffort)) || (detail.reasoningEfforts !== undefined && (!Array.isArray(detail.reasoningEfforts) || detail.reasoningEfforts.some(effort => !reasoningEfforts.includes(effort)))))) return false
    }
    if (u.activeProviderId !== null && !u.providers.some(p => p.id === u.activeProviderId)) return false
    if (u.selectedModel !== null && (typeof u.selectedModel !== 'string' || !u.providers.some(p => p.id === u.activeProviderId && p.availableModels.includes(u.selectedModel!)))) return false
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
  if (state.session !== null) {
    if (!state.session || !ids.has(state.session.userId) || typeof state.session.tokenHash !== 'string' || typeof state.session.encryptedToken !== 'string') return false
  }
  return true
}

/** JSON 状态仓库，依赖 Node 文件系统与领域格式；只负责读取、校验和事务保存，不处理登录及会话业务。 */
export class StateRepository {
  state: StoredState

  /** 从 schema 3 文件读取数据，缺失时使用空状态；损坏时拒绝覆盖，由 StateService 完成启动业务恢复。 */
  constructor(private readonly path: string) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (!validState(parsed)) throw new Error('Invalid state')
      this.state = parsed as StoredState
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取本地数据，请备份数据文件后检查格式。')
      this.state = { schemaVersion: 3, users: [], activeUserId: null, activeConversationId: null, conversations: [], session: null }
    }
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

  /** 保存一次原子修改；业务回调或磁盘保存失败时恢复原数据，由 Service 恢复其运行时身份。 */
  transaction<T>(update: () => T): T {
    const previous = structuredClone(this.state)
    try {
      const result = update()
      this.save()
      return result
    } catch (error) {
      this.state = previous
      throw error
    }
  }
}
