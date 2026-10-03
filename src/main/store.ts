import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Action, AppState, Conversation, Message, Snapshot } from '../shared/types'
import type { ModelConfig } from './config'

export function textInput(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new Error(`请输入 1–${max} 个字符。`)
  }
  return value.trim()
}

function initialState(): AppState {
  const user = { id: randomUUID(), name: '开发者', createdAt: new Date().toISOString() }
  return { schemaVersion: 1, users: [user], activeUserId: user.id, activeConversationId: null, conversations: [], theme: 'light' }
}

function validState(value: unknown): value is AppState {
  if (!value || typeof value !== 'object') return false
  const state = value as AppState
  if (state.schemaVersion !== 1 || !Array.isArray(state.users) || !state.users.length || !Array.isArray(state.conversations)) return false
  const ids = new Set<string>()
  for (const user of state.users) {
    if (typeof user.id !== 'string' || ids.has(user.id) || typeof user.name !== 'string' || !user.name.trim() || typeof user.createdAt !== 'string') return false
    ids.add(user.id)
  }
  if (!ids.has(state.activeUserId) || !['light', 'dark'].includes(state.theme)) return false
  const conversationIds = new Set<string>()
  for (const c of state.conversations) {
    if (typeof c.id !== 'string' || conversationIds.has(c.id) || !ids.has(c.userId) || typeof c.title !== 'string' || typeof c.model !== 'string' || typeof c.createdAt !== 'string' || typeof c.updatedAt !== 'string' || !Array.isArray(c.messages)) return false
    conversationIds.add(c.id)
    const messageIds = new Set<string>()
    for (const m of c.messages) {
      if (typeof m.id !== 'string' || messageIds.has(m.id) || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || typeof m.reasoning !== 'string' || !['complete', 'streaming', 'stopped', 'error'].includes(m.status) || typeof m.createdAt !== 'string' || (m.error !== undefined && typeof m.error !== 'string')) return false
      messageIds.add(m.id)
    }
  }
  return state.activeConversationId === null || state.conversations.some(c => c.id === state.activeConversationId && c.userId === state.activeUserId)
}

export class Store {
  state: AppState

  constructor(private readonly path: string) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (!validState(parsed)) throw new Error('Invalid state')
      this.state = parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取本地数据，请备份数据文件后检查格式。')
      this.state = initialState()
    }
    for (const c of this.state.conversations) {
      for (const m of c.messages) if (m.status === 'streaming') m.status = 'stopped'
    }
    this.save()
  }

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

  snapshot(config: ModelConfig): Snapshot {
    return structuredClone({
      ...this.state,
      conversations: this.state.conversations.filter(c => c.userId === this.state.activeUserId),
      config: { baseUrl: config.baseUrl, model: config.model, configured: Boolean(config.apiKey) }
    })
  }

  conversation(id: unknown): Conversation {
    const c = this.state.conversations.find(c => c.id === id && c.userId === this.state.activeUserId)
    if (!c) throw new Error('会话不存在。')
    return c
  }

  apply(action: Action): void {
    if (!action || typeof action !== 'object') throw new Error('无效操作。')
    this.transaction(() => {
      switch (action.type) {
        case 'user:create': {
          const user = { id: randomUUID(), name: textInput(action.name, 40), createdAt: new Date().toISOString() }
          this.state.users.push(user)
          this.state.activeUserId = user.id
          this.state.activeConversationId = null
          break
        }
        case 'user:rename': {
          const user = this.state.users.find(u => u.id === action.id)
          if (!user) throw new Error('用户不存在。')
          user.name = textInput(action.name, 40)
          break
        }
        case 'user:switch':
          if (!this.state.users.some(u => u.id === action.id)) throw new Error('用户不存在。')
          this.state.activeUserId = action.id
          this.state.activeConversationId = null
          break
        case 'user:delete':
          if (!this.state.users.some(u => u.id === action.id)) throw new Error('用户不存在。')
          if (this.state.users.length === 1) throw new Error('至少保留一个用户。')
          this.state.users = this.state.users.filter(u => u.id !== action.id)
          this.state.conversations = this.state.conversations.filter(c => c.userId !== action.id)
          if (this.state.activeUserId === action.id) {
            this.state.activeUserId = this.state.users[0].id
            this.state.activeConversationId = null
          }
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
          this.state.theme = action.theme
          break
        default: throw new Error('无效操作。')
      }
    })
  }

  begin(content: unknown, retry: boolean, model: string): { conversation: Conversation; message: Message } {
    return this.transaction(() => {
      let c = this.state.activeConversationId ? this.conversation(this.state.activeConversationId) : undefined
      if (retry) {
        if (!c || c.messages.at(-1)?.role !== 'assistant' || c.messages.at(-2)?.role !== 'user') throw new Error('没有可重新生成的回复。')
        c.messages.pop()
      } else {
        const text = textInput(content, 32_000)
        if (!c) {
          const now = new Date().toISOString()
          c = { id: randomUUID(), userId: this.state.activeUserId, title: text.replace(/\s+/g, ' ').slice(0, 32), model, createdAt: now, updatedAt: now, messages: [] }
          this.state.conversations.push(c)
          this.state.activeConversationId = c.id
        }
        c.messages.push({ id: randomUUID(), role: 'user', content: text, reasoning: '', status: 'complete', createdAt: new Date().toISOString() })
      }
      c!.model = model
      c!.updatedAt = new Date().toISOString()
      const message: Message = { id: randomUUID(), role: 'assistant', content: '', reasoning: '', status: 'streaming', createdAt: new Date().toISOString() }
      c!.messages.push(message)
      return { conversation: c!, message }
    })
  }
}

export function contextMessages(conversation: Conversation): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const result: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: '你是 DCode，一位严谨、简洁的编程助手。使用用户的语言回答，代码使用带语言标记的 Markdown 代码块。不要声称已经执行代码或访问文件。' }
  ]
  for (let i = 0; i < conversation.messages.length; i += 2) {
    const user = conversation.messages[i]
    const assistant = conversation.messages[i + 1]
    if (!user || user.role !== 'user') continue
    if (assistant?.status === 'complete' && assistant.content) {
      result.push({ role: 'user', content: user.content }, { role: 'assistant', content: assistant.content })
    } else if (i === conversation.messages.length - 2) result.push({ role: 'user', content: user.content })
  }
  return result
}
