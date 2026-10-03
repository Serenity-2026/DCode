export type Theme = 'light' | 'dark'
export type MessageStatus = 'streaming' | 'complete' | 'stopped' | 'error'

export interface User {
  id: string
  name: string
  createdAt: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning: string
  status: MessageStatus
  error?: string
  createdAt: string
}

export interface Conversation {
  id: string
  userId: string
  title: string
  model: string
  createdAt: string
  updatedAt: string
  messages: Message[]
}

export interface AppState {
  schemaVersion: 1
  users: User[]
  activeUserId: string
  activeConversationId: string | null
  conversations: Conversation[]
  theme: Theme
}

export interface Snapshot extends Omit<AppState, 'conversations'> {
  conversations: Conversation[]
  config: { baseUrl: string; model: string; configured: boolean }
}

export type Action =
  | { type: 'user:create'; name: string }
  | { type: 'user:rename'; id: string; name: string }
  | { type: 'user:switch'; id: string }
  | { type: 'user:delete'; id: string }
  | { type: 'conversation:select'; id: string | null }
  | { type: 'conversation:rename'; id: string; title: string }
  | { type: 'conversation:delete'; id: string }
  | { type: 'theme'; theme: Theme }

export interface StreamEvent {
  conversationId: string
  message: Message
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export interface DCodeAPI {
  getState(): Promise<Result<Snapshot>>
  action(action: Action): Promise<Result<Snapshot>>
  send(input: { content: string; retry?: boolean }): Promise<Result<Snapshot>>
  stop(): Promise<Result<Snapshot>>
  onStream(callback: (event: StreamEvent) => void): () => void
  openLink(url: string): Promise<Result<void>>
  copyText(text: string): Promise<Result<void>>
}
