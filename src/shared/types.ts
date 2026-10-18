import type { Typography } from './appearance'
import type { UsageRecord } from './usage'

/** 账号保存的外观偏好，由 Root 映射到 Ant Design 主题。 */
export type Theme = 'light' | 'dark'
/** 服务使用的实际传输协议，与模型名称无关。 */
export type ModelApi = 'openai-completions' | 'anthropic-messages'
/** AgentSession 维护的回复状态，StateService 会将上次遗留的生成标记为停止。 */
export type MessageStatus = 'streaming' | 'complete' | 'stopped' | 'error'

/** Models 从服务元数据确认的推理档位，StateService 保存账号选择，streamModel 发送实际参数。 */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

/** 系统选择器读取的文本快照，目录路径仅为附件来源，不改变会话 cwd。 */
export interface Attachment { id: string; name: string; kind: 'file' | 'folder'; fileCount: number; content: string; path?: string }

/** 附件选择结果，提示被跳过的文件，不静默把非文本文件当成已添加。 */
export interface AttachmentSelection { attachments: Attachment[]; skipped: number }

/** AgentSession 的发送输入，重试复用已保存的附件，不能通过此接口要求读取本机路径。 */
export interface SendInput { content: string; retry?: boolean; attachments?: Attachment[]; conversationId?: string | null }

/** 撤销一轮的全部文件或其中一个文件；不接受页面提交磁盘路径。 */
export interface UndoFilesInput { conversationId: string; messageId: string; changeId?: string }

/** 每轮按文件汇总的净变化；完整恢复副本仅保存在主进程。 */
export interface FileChange {
  id: string
  path: string
  additions: number
  deletions: number
  /*
  * pending:已保存修改前内容和预期修改后内容，但写入结果尚未完成记录
  * applied:已完成写后记录，可以根据保存的内容检查、撤销这次变化
  * reverted:已完成撤销，或者恢复检查确认文件已经处于修改前的内容
  * */
  status: 'pending' | 'applied' | 'reverted'
  preview: FilePreview
}

/** 项目名称与用户通过原生选择器确认的父目录；不选位置时使用应用工作区。 */
export interface ProjectDraft { name: string; parentDirectory?: string }

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
  toolExecutions?: ToolExecution[]
  fileChanges?: FileChange[]
  /** 后台生成的后续提问；用户采纳前不作为输入或模型上下文。 */
  suggestedPrompt?: string
}

/** 属于一个账号的完整对话，StateService 持久化，AgentSession 构建模型上下文。 */
export interface Conversation {
  id: string
  userId: string
  directory: string
  title: string
  model: string
  createdAt: string
  updatedAt: string
  messages: Message[]
}

/** 服务公开配置，availableModels 合并服务目录与用户填写的 manualModels。 */
export interface ProviderProfile { id: string; name: string; baseUrl: string; api?: ModelApi; availableModels: string[]; manualModels?: string[]; modelDetails?: Record<string, ModelDetails>; selectedEfforts?: Record<string, ReasoningEffort> }

/** 服务实际返回的上下文窗口、受支持强度和默认档位，没有返回的字段保持未知。 */
export interface ModelDetails { contextWindow?: number; reasoningEfforts?: ReasoningEffort[]; defaultEffort?: ReasoningEffort }

/** 设置表单提交的配置；编辑时 apiKey 留空表示保留现有密钥。 */
export interface ProviderDraft { id?: string; name: string; baseUrl: string; apiKey: string; api?: ModelApi; manualModels?: string[] }

/** 界面可见状态；未登录时不包含账号、聊天或模型配置。 */
export interface Snapshot {
  usageRecords?: UsageRecord[]
  users: User[]
  activeUserId: string | null
  activeConversationId: string | null
  conversations: Conversation[]
  theme: Theme
  typography?: Typography
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
  | { type: 'folder:delete'; id: string }
  | { type: 'model:select'; providerId: string; model: string }
  | { type: 'fast-mode'; enabled: boolean }
  | { type: 'reasoning-effort'; effort: ReasoningEffort | null }
  | { type: 'theme'; theme: Theme }
  | { type: 'typography'; typography: Typography }

/** 调用时的有界文本快照；修改工具另附统一差异，不从界面读取任意磁盘路径。 */
export interface FilePreview { content: string; diff?: string; startLine?: number; totalLines?: number; truncated?: boolean }

/** 工具调用在回复正文中的位置、文件链接和预览；不保存完整调用参数。 */
export interface ToolExecution {
  id: string
  name: string
  status: 'running' | 'complete' | 'error' | 'stopped'
  offset?: number
  path?: string
  command?: string
  preview?: FilePreview
}

/** 流更新携带完整消息及工具记录；后台建议更新不改变会话排序。 */
export interface StreamEvent { conversationId: string; message: Message; usageRecord?: UsageRecord; background?: boolean }

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
  /** 选择工作目录创建会话，取消返回 null；传入已有会话 ID 时复用其目录。 */
  createConversation(sourceId?: string): Promise<Result<Snapshot | null>>
  /** 选择新项目的创建位置，取消时返回 null。 */
  selectProjectDirectory(): Promise<Result<string | null>>
  /** 在默认工作区或刚选择的位置创建同名目录和首段对话。 */
  createProject(input: ProjectDraft): Promise<Result<Snapshot>>
  /** 使用当前账号选中的模型生成回复。 */
  send(input: SendInput): Promise<Result<Snapshot>>
  /** 打开系统选择器，读取文件或文件夹的附件文本快照。 */
  selectAttachments(kind: 'file' | 'folder'): Promise<Result<AttachmentSelection>>
  /** 停止指定会话的任务并等待结果保存，不影响其他会话。 */
  stop(conversationId: string): Promise<Result<Snapshot>>
  /** 撤销指定回复的文件修改，保留聊天记录。 */
  undoFiles(input: UndoFilesInput): Promise<Result<Snapshot>>
  /** 订阅消息更新，返回退订函数。 */
  onStream(callback: (event: StreamEvent) => void): () => void
  /** 校验后在系统浏览器打开链接。 */
  openLink(url: string): Promise<Result<void>>
  /** 将文本写入系统剪贴板。 */
  copyText(text: string): Promise<Result<void>>
}
