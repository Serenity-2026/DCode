/** 账号保存的外观偏好，由 Root 映射到 Ant Design 主题。 */
export type Theme = 'light' | 'dark'
/** 服务使用的实际传输协议，与模型名称无关。 */
export type ModelApi = 'openai-completions' | 'anthropic-messages'
/** AgentSession 维护的回复状态，StateService 会将上次遗留的生成标记为停止。 */
export type MessageStatus = 'streaming' | 'complete' | 'stopped' | 'error'

/** Models 从服务元数据确认的推理档位，StateService 保存账号选择，streamModel 发送实际参数。 */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

/** 系统选择器读取的文本快照；目录另存绝对路径，AgentSession 为本轮工具恢复 cwd。 */
export interface Attachment { id: string; name: string; kind: 'file' | 'folder'; fileCount: number; content: string; path?: string }

/** 附件选择结果，提示被跳过的文件，不静默把非文本文件当成已添加。 */
export interface AttachmentSelection { attachments: Attachment[]; skipped: number }

/** AgentSession 的发送输入，重试复用已保存的附件，不能通过此接口要求读取本机路径。 */
export interface SendInput { content: string; retry?: boolean; attachments?: Attachment[] }

/** 公开账号信息，不包含密码哈希、会话令牌或模型密钥。 */
export interface User { id: string; name: string; username: string; createdAt: string }

/** 单条对话消息，由 AgentSession 更新，Workspace 与 Markdown 展示。 */
export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning: string
  status: MessageStatus
  error?: string
  createdAt: string
  attachments?: Attachment[]
}

/** 属于一个账号的完整对话，StateService 持久化，AgentSession 构建模型上下文。 */
export interface Conversation {
  id: string
  userId: string
  title: string
  model: string
  createdAt: string
  updatedAt: string
  messages: Message[]
}

/** 服务公开配置、实际模型列表及账号为各模型选中的档位，模型 ID 只能来自 /models 响应。 */
export interface ProviderProfile { id: string; name: string; baseUrl: string; api?: ModelApi; availableModels: string[]; modelDetails?: Record<string, ModelDetails>; selectedEfforts?: Record<string, ReasoningEffort> }

/** 服务实际返回的上下文窗口、受支持强度和默认档位，没有返回的字段保持未知。 */
export interface ModelDetails { contextWindow?: number; reasoningEfforts?: ReasoningEffort[]; defaultEffort?: ReasoningEffort }

/** 设置表单提交的配置；编辑时 apiKey 留空表示保留现有密钥。 */
export interface ProviderDraft { id?: string; name: string; baseUrl: string; apiKey: string; api?: ModelApi }

/** 界面可见状态；未登录时不包含账号、聊天或模型配置。 */
export interface Snapshot {
  users: User[]
  activeUserId: string | null
  activeConversationId: string | null
  conversations: Conversation[]
  theme: Theme
  providers: ProviderProfile[]
  activeProviderId: string | null
  selectedModel: string | null
  fastMode: boolean
  reasoningEffort: ReasoningEffort | null
  config: { baseUrl: string; model: string; configured: boolean }
}

/** 刷新各服务后的公开状态与失败提示，成功服务可独立更新，失败服务保留缓存。 */
export interface ModelRefresh { snapshot: Snapshot; errors: string[] }

/** 本机账号的注册/登录输入，由 Auth 校验账号格式与密码长度。 */
export interface AuthInput { username: string; password: string }

/** 已登录账号允许执行的操作，StateService 再次校验账号与数据归属。 */
export type Action =
  | { type: 'user:rename'; id: string; name: string }
  | { type: 'conversation:select'; id: string | null }
  | { type: 'conversation:rename'; id: string; title: string }
  | { type: 'conversation:delete'; id: string }
  | { type: 'model:select'; providerId: string; model: string }
  | { type: 'fast-mode'; enabled: boolean }
  | { type: 'reasoning-effort'; effort: ReasoningEffort | null }
  | { type: 'theme'; theme: Theme }

/** 流更新携带完整消息，Workspace 按 ID 替换对应回复。 */
export interface StreamEvent { conversationId: string; message: Message }

/** 主进程 IPC 的成功/失败结果，不向界面泄露秘密。 */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

/** preload 的业务白名单；依赖主进程 Auth、Models、StateService 和 AgentSession，不暴露原始 IPC。 */
export interface DCodeAPI {
  /** 获取当前登录状态及账号快照。 */
  getState(): Promise<Result<Snapshot>>
  /** 注册账号并保持登录。 */
  register(input: AuthInput): Promise<Result<Snapshot>>
  /** 验证账号密码并保持登录。 */
  login(input: AuthInput): Promise<Result<Snapshot>>
  /** 注销记住的会话，必须再次输入密码才能进入。 */
  logout(): Promise<Result<Snapshot>>
  /** 使用准确的 URL 和密钥获取模型列表，成功才加密保存服务。 */
  saveProvider(input: ProviderDraft): Promise<Result<Snapshot>>
  /** 重新读取当前账号所有服务的模型列表，不向界面暴露密钥。 */
  refreshModels(): Promise<Result<ModelRefresh>>
  /** 修改当前账号的资料、会话、模型选择或主题。 */
  action(action: Action): Promise<Result<Snapshot>>
  /** 使用当前账号选中的模型生成回复。 */
  send(input: SendInput): Promise<Result<Snapshot>>
  /** 打开系统选择器，读取文本快照并记录所选文件夹的工具工作目录。 */
  selectAttachments(kind: 'file' | 'folder'): Promise<Result<AttachmentSelection>>
  /** 停止生成并等待结果保存。 */
  stop(): Promise<Result<Snapshot>>
  /** 订阅消息更新，返回退订函数。 */
  onStream(callback: (event: StreamEvent) => void): () => void
  /** 校验后在系统浏览器打开链接。 */
  openLink(url: string): Promise<Result<void>>
  /** 将文本写入系统剪贴板。 */
  copyText(text: string): Promise<Result<void>>
}
