import type { Conversation, FileChange, ProviderProfile, Theme, User } from '../../shared/types'
import type { Typography } from '../../shared/appearance'
import type { UsageRecord } from '../../shared/usage'
import type { McpServerConfig } from '../../shared/mcp'

export interface StoredMcpServer extends McpServerConfig { encryptedSecrets?: string; encryptedOAuth?: string }

/** 主进程保存的完整字节快照，以 base64 保留 BOM、换行和空文件；null 表示文件不存在。 */
export interface StoredFileChange extends FileChange {
  userId: string
  conversationId: string
  messageId: string
  absolutePath: string
  parentDirectory: string
  before: string | null
  after: string | null
}

/** 仅在主进程保存的账号记录；Auth 管理密码与会话，Models 管理密钥密文。 */
export interface StoredUser extends User {
  mcpServers?: StoredMcpServer[]
  usageRecords?: UsageRecord[]
  passwordHash: string
  passwordSalt: string
  theme: Theme
  typography?: Typography
  providers: (ProviderProfile & { encryptedApiKey: string })[]
  activeProviderId: string | null
  selectedModel: string | null
  fastMode: boolean
}

/** 保持登录的令牌只以 OS 加密密文保存，Auth 在启动时解密并核对哈希。 */
export interface RememberedSession { userId: string; tokenHash: string; encryptedToken: string }

/** schema 4 的磁盘格式，不能直接通过 IPC 返回给界面。 */
export interface StoredState {
  schemaVersion: 4
  users: StoredUser[]
  activeUserId: string | null
  activeConversationId: string | null
  conversations: Conversation[]
  session: RememberedSession | null
  fileChanges?: StoredFileChange[]
}
