/** Store 保存的外观偏好，由 renderer 的 Root 组件映射到 Ant Design 主题。 */
export type Theme = 'light' | 'dark'
/** Chat 维护的回复状态；Store 启动恢复时会把遗留的 streaming 改为 stopped。 */
export type MessageStatus = 'streaming' | 'complete' | 'stopped' | 'error'

/** 本地用户档案，由 Store 创建和管理；用于会话归属，不承担服务端身份认证。 */
export interface User {
  id: string
  name: string
  createdAt: string
}

/** 会话中的单条消息；Chat 更新回复内容及状态，Markdown/Workspace 负责展示。 */
export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning: string
  status: MessageStatus
  error?: string
  createdAt: string
}

/** 属于某个 User 的完整对话，包含有序 Message；Store 持久化，Chat 将其转换为模型上下文。 */
export interface Conversation {
  id: string
  userId: string
  title: string
  model: string
  createdAt: string
  updatedAt: string
  messages: Message[]
}

/** Store 保存到磁盘的完整应用状态，包含全部本地用户、会话和当前选择。 */
export interface AppState {
  schemaVersion: 1
  users: User[]
  activeUserId: string
  activeConversationId: string | null
  conversations: Conversation[]
  theme: Theme
}

/** Store.snapshot 返回给界面的状态副本：会话仅属于当前用户，config 不包含模型密钥。 */
export interface Snapshot extends Omit<AppState, 'conversations'> {
  conversations: Conversation[]
  config: { baseUrl: string; model: string; configured: boolean }
}

/** renderer 可请求的管理操作白名单；preload 转发，Store.apply 校验并执行。 */
export type Action =
  | { type: 'user:create'; name: string }
  | { type: 'user:rename'; id: string; name: string }
  | { type: 'user:switch'; id: string }
  | { type: 'user:delete'; id: string }
  | { type: 'conversation:select'; id: string | null }
  | { type: 'conversation:rename'; id: string; title: string }
  | { type: 'conversation:delete'; id: string }
  | { type: 'theme'; theme: Theme }

/** Chat 经 IPC 推送的回复更新，携带当前完整 Message；Workspace 按 ID 替换消息而非追加 token。 */
export interface StreamEvent {
  conversationId: string
  message: Message
}

/** 主进程 handle 统一包装的 IPC 返回值，界面检查 ok 后读取结果或显示错误。 */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * preload 通过 contextBridge 注入 window.dcode 的接口契约。
 * renderer 依赖该接口调用主进程的 Store/Chat 和指定系统能力，不能直接接触 Electron IPC。
 */
export interface DCodeAPI {
  /** 获取 Store 提供的当前用户快照。 */
  getState(): Promise<Result<Snapshot>>
  /** 请求 Store 执行管理操作，并返回更新后的快照。 */
  action(action: Action): Promise<Result<Snapshot>>
  /** 请求 Chat 发送/重试；先返回快照，后续更新由 onStream 接收。 */
  send(input: { content: string; retry?: boolean }): Promise<Result<Snapshot>>
  /** 请求 Chat 停止生成并保存，返回最终快照。 */
  stop(): Promise<Result<Snapshot>>
  /** 订阅回复更新，返回卸载监听用的退订函数。 */
  onStream(callback: (event: StreamEvent) => void): () => void
  /** 请求主进程校验链接后在系统浏览器打开。 */
  openLink(url: string): Promise<Result<void>>
  /** 请求主进程把文本写入剪贴板。 */
  copyText(text: string): Promise<Result<void>>
}
