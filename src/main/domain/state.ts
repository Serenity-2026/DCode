import type { Conversation, ProviderProfile, Theme, User } from '../../shared/types'

/** 仅在主进程保存的账号记录；Auth 管理密码与会话，Models 管理密钥密文。 */
export interface StoredUser extends User {
  passwordHash: string
  passwordSalt: string
  theme: Theme
  providers: (ProviderProfile & { encryptedApiKey: string })[]
  activeProviderId: string | null
  selectedModel: string | null
  fastMode: boolean
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
