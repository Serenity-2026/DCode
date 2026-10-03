/** 账号保存的外观偏好，由 Root 映射到 Ant Design 主题。 */
export type Theme = 'light' | 'dark'
/** Chat 维护的回复状态，Store 会将上次遗留的生成标记为停止。 */
export type MessageStatus = 'streaming' | 'complete' | 'stopped' | 'error'

/** 公开账号信息，不包含密码哈希、会话令牌或模型密钥。 */
export interface User { id: string; name: string; username?: string; createdAt: string }

/** 单条对话消息，由 Chat 更新，Workspace 与 Markdown 展示。 */
export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning: string
  status: MessageStatus
  error?: string
  createdAt: string
}

/** 属于一个账号的完整对话，Store 持久化，Chat 构建模型上下文。 */
export interface Conversation {
  id: string
  userId: string
  title: string
  model: string
  createdAt: string
  updatedAt: string
  messages: Message[]
}

/** 不含秘密的模型配置，供模型菜单与设置表单使用。 */
export interface ModelProfile { id: string; name: string; baseUrl: string; model: string }

/** 设置表单提交的配置；编辑时 apiKey 留空表示保留现有密钥。 */
export interface ModelDraft extends Omit<ModelProfile, 'id'> { id?: string; apiKey: string }

/** 界面可见状态；未登录时不包含账号、聊天或模型配置。 */
export interface Snapshot {
  users: User[]
  activeUserId: string | null
  activeConversationId: string | null
  conversations: Conversation[]
  theme: Theme
  legacyUsers: User[]
  models: ModelProfile[]
  activeModelId: string | null
  config: { baseUrl: string; model: string; configured: boolean }
}

/** 注册/登录输入由 Auth 校验；legacyUserId 可将首版档案关联到新账号。 */
export interface AuthInput { username: string; password: string; legacyUserId?: string }

/** 已登录账号允许执行的操作，Store 再次校验账号与数据归属。 */
export type Action =
  | { type: 'user:rename'; id: string; name: string }
  | { type: 'conversation:select'; id: string | null }
  | { type: 'conversation:rename'; id: string; title: string }
  | { type: 'conversation:delete'; id: string }
  | { type: 'model:select'; id: string }
  | { type: 'theme'; theme: Theme }

/** 流更新携带完整消息，Workspace 按 ID 替换对应回复。 */
export interface StreamEvent { conversationId: string; message: Message }

/** 主进程 IPC 的成功/失败结果，不向界面泄露秘密。 */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

/** preload 的业务白名单；依赖主进程 Auth、Models、Store 和 Chat，不暴露原始 IPC。 */
export interface DCodeAPI {
  /** 获取当前登录状态及账号快照。 */
  getState(): Promise<Result<Snapshot>>
  /** 注册账号并保持登录，可关联旧档案。 */
  register(input: AuthInput): Promise<Result<Snapshot>>
  /** 验证账号密码并保持登录。 */
  login(input: AuthInput): Promise<Result<Snapshot>>
  /** 注销记住的会话，必须再次输入密码才能进入。 */
  logout(): Promise<Result<Snapshot>>
  /** 测试准确配置，成功后加密保存并选中，失败则保留旧值。 */
  saveModel(input: ModelDraft): Promise<Result<Snapshot>>
  /** 修改当前账号的资料、会话、模型选择或主题。 */
  action(action: Action): Promise<Result<Snapshot>>
  /** 使用当前账号选中的模型生成回复。 */
  send(input: { content: string; retry?: boolean }): Promise<Result<Snapshot>>
  /** 停止生成并等待结果保存。 */
  stop(): Promise<Result<Snapshot>>
  /** 订阅消息更新，返回退订函数。 */
  onStream(callback: (event: StreamEvent) => void): () => void
  /** 校验后在系统浏览器打开链接。 */
  openLink(url: string): Promise<Result<void>>
  /** 将文本写入系统剪贴板。 */
  copyText(text: string): Promise<Result<void>>
}
