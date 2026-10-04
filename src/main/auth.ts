import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import type { AuthInput, Snapshot } from '../shared/types'
import type { SecretCodec } from './secrets'
import type { Models } from './models'
import { Store, textInput, type RememberedSession, type StoredUser } from './store'

/** 校验账号格式并统一大小写，供注册去重与登录查找共用；密码不经过文本裁剪。 */
function username(value: unknown): string {
  const name = textInput(value, 32).normalize('NFKC').toLowerCase()
  if (!/^[\p{L}\p{N}_.-]{3,32}$/u.test(name)) throw new Error('账号需为 3–32 个字母、数字或 _ . -。')
  return name
}

/** 校验密码长度，保持用户输入的空白与大小写，避免改变实际密码。 */
function password(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) throw new Error('密码需为 8–128 个字符。')
  return value
}

/** 固定长度比较哈希，避免普通字符串比较随相同前缀长度变化。 */
function matches(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** 本机账号认证与保持登录，依赖 Store 保存账号、Secrets 保护令牌、Models 导入首个账号配置。 */
export class Auth {
  /** 注入持久化与秘密保护；主进程注册 IPC 前调用 restore 恢复有效会话。 */
  constructor(private store: Store, private secrets: SecretCodec, private models: Models) {}

  /** 将账号 ID 与随机令牌一起 OS 加密，防止修改磁盘账号 ID 后复用另一个账号的令牌。 */
  private async session(userId: string): Promise<RememberedSession> {
    const token = randomBytes(32).toString('hex')
    return { userId, tokenHash: createHash('sha256').update(token).digest('hex'), encryptedToken: await this.secrets.encrypt(JSON.stringify({ userId, token })) }
  }

  /** 创建本机账号，依赖 Store 保存密码哈希与会话，Models 为首个账号导入环境配置。 */
  async register(input: AuthInput): Promise<Snapshot> {
    if (this.store.snapshot().activeUserId) throw new Error('请先退出当前账号。')
    const name = username(input?.username)
    const pass = password(input?.password)
    if (this.store.state.users.some(u => u.username === name)) throw new Error('该账号已存在。')
    const salt = randomBytes(16).toString('hex')
    const user: StoredUser = {
      id: randomUUID(), name, createdAt: new Date().toISOString(), theme: 'light', providers: [], activeProviderId: null, selectedModel: null, fastMode: false,
      username: name, passwordSalt: salt, passwordHash: scryptSync(pass, salt, 64).toString('hex')
    }
    if (!this.store.state.users.length) {
      const profile = await this.models.bootstrap()
      if (profile) { user.providers = [profile]; user.activeProviderId = profile.id }
    }
    const session = await this.session(user.id)
    this.store.transaction(() => {
      if (this.store.state.users.some(u => u.username === name)) throw new Error('该账号已存在。')
      this.store.state.users.push(user)
      this.store.authenticate(user.id)
      this.store.state.session = session
    })
    return this.store.snapshot()
  }

  /** 验证 scrypt 密码哈希并轮换记住的令牌；错误账号/密码使用同一提示。 */
  async login(input: AuthInput): Promise<Snapshot> {
    if (this.store.snapshot().activeUserId) throw new Error('请先退出当前账号。')
    const name = username(input?.username)
    const pass = password(input?.password)
    const user = this.store.state.users.find(u => u.username === name)
    const hash = scryptSync(pass, user?.passwordSalt || 'invalid-account-salt', 64).toString('hex')
    if (!user?.passwordHash || !matches(hash, user.passwordHash)) throw new Error('账号或密码不正确。')
    const session = await this.session(user.id)
    this.store.transaction(() => { this.store.authenticate(user.id); this.store.state.session = session })
    return this.store.snapshot()
  }

  /** 启动时解密并验证持久化令牌；令牌无效时撤销会话，不信任磁盘上的 activeUserId。 */
  async restore(): Promise<void> {
    const session = this.store.state.session
    if (!session) { this.store.clearAuthentication(); return }
    try {
      const payload = JSON.parse(await this.secrets.decrypt(session.encryptedToken)) as { userId: string; token: string }
      if (payload.userId !== session.userId || typeof payload.token !== 'string' || !matches(createHash('sha256').update(payload.token).digest('hex'), session.tokenHash)) throw new Error('Invalid session')
      this.store.authenticate(session.userId)
    } catch {
      this.store.transaction(() => { this.store.state.session = null; this.store.clearAuthentication() })
    }
  }

  /** 主动退出时同时删除持久化令牌和运行时身份，保留账号所属的聊天与配置。 */
  logout(): Snapshot {
    this.store.transaction(() => { this.store.state.session = null; this.store.clearAuthentication() })
    return this.store.snapshot()
  }
}
