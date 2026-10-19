import { randomUUID } from 'node:crypto'
import { validMcpConfig, type McpAction, type McpServerConfig, type McpServerDraft, type McpServerView } from '../../shared/mcp'
import type { SecretCodec } from '../domain/ports'
import type { AgentTool } from '../domain/llm'
import type { StoredMcpServer } from '../domain/state'
import { McpConnection } from '../infrastructure/mcp/client'
import { McpOAuth } from '../infrastructure/mcp/oauth'
import { StateService } from './state-service'
/*
| `userId` | 连接属于哪个 DCode 账号 | `"user-a"` |
| `serverId` | 使用哪一条 MCP 配置 | `"server-123"` |
| `scope` | 连接属于哪个使用场景 | 对话 ID 或 `"settings"` |
| `context` | 给界面显示的上下文名称 | 对话标题或 `"连接测试"` |
| `client` | 真正负责连接和调用的对象 | 一个 `McpConnection` 实例 |
* */
type Connection = { userId: string; serverId: string; scope: string; context: string; client: McpConnection }

/** 账号配置、目录隔离与连接生命周期；网络和进程实现留在独立客户端。 */
export class McpService {
  private connections: Connection[] = []
  private readonly oauth = new Map<string, McpOAuth>()
  //登记尚未结束的任务
  private readonly pending = new Set<Promise<unknown>>()
  //递增计数，用来识别异步创建连接期间，服务是否发生了清理操作。
  private version = 0
  //openUrl是打开浏览器的函数。
  constructor(private readonly state: StateService, private readonly secrets: SecretCodec, private readonly defaultDirectory: string, private readonly openUrl: (url: string) => Promise<void>) {}

  list(): McpServerView[] {
    const user = this.state.requireUser()
    return (user.mcpServers || []).map(({ encryptedSecrets, encryptedOAuth, ...config }) => ({
      ...structuredClone(config), hasSecrets: Boolean(encryptedSecrets),
      connections: this.connections.filter(c => c.userId === user.id && c.serverId === config.id).map(c => ({
        context: c.context, status: config.enabled ? c.client.status : 'disabled', error: c.client.error,
        tools: c.client.tools.map(t => ({ name: t.name, description: t.description }))
      }))
    }))
  }

  async save(input: McpServerDraft): Promise<McpServerView[]> {
    const userId = this.state.requireUser().id
    if (!input || typeof input !== 'object') throw new Error('MCP 配置无效。')
    const id = input.id || randomUUID()
    const previous = this.state.requireUser().mcpServers?.find(s => s.id === id)
    //新建配置or更新配置,如果是更新配置会检查传入的mcp-id是否有原配置
    if (input.id && !previous)
      throw new Error('MCP 服务器不存在。')
    const config: McpServerConfig =
        { id, name: input.name, transport: input.transport, command: input.command, args: input.args, url: input.url, auth: input.auth, enabled: input.enabled }
    if (!validMcpConfig(config))
      throw new Error('MCP 配置无效：名称只能包含字母、数字、下划线和短横线；远程地址必须使用 HTTPS（本机除外）。')
    if (this.state.requireUser().mcpServers?.
    some(s => s.id !== id && s.name === config.name))
      throw new Error('MCP 名称已存在。')
    let encryptedSecrets = previous?.encryptedSecrets
    if (input.secrets !== undefined) {
      const pairs = Object.entries(input.secrets || {})
      if (!input.secrets || typeof input.secrets !== 'object' ||
          Array.isArray(input.secrets) || pairs.length > 100 ||
          pairs.some(([k, v]) => !k || k.length > 256 ||
              typeof v !== 'string' || v.length > 8192 ||
              k.includes('\0') || v.includes('\0')))
        throw new Error('环境变量或请求头必须是字符串键值对象。')
      if (config.transport === 'http' &&
          pairs.some(([k, v]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k) || /[\r\n]/.test(v)))
        throw new Error('HTTP 请求头格式无效。')
      encryptedSecrets = pairs.length ? await this.secrets.encrypt(JSON.stringify(input.secrets)) : undefined
    } else if (previous && (previous.transport !== config.transport ||
        previous.url !== config.url || previous.auth !== config.auth ||
        previous.command !== config.command || JSON.stringify(previous.args) !== JSON.stringify(config.args))) {
      // 地址或启动命令变化时不将旧凭据交给新服务器。
      encryptedSecrets = undefined
    }
    if (this.state.requireUser().id !== userId)
      throw new Error('账号已切换。')
    const retainOAuth = previous?.url === config.url && previous.auth === config.auth
    const stored: StoredMcpServer = { ...config, encryptedSecrets, ...(retainOAuth ? { encryptedOAuth: previous.encryptedOAuth } : {}) }
    this.state.transaction(() => {
      const user = this.state.requireUser()
      user.mcpServers = [...(user.mcpServers || []).filter(s => s.id !== id), stored]
    })
    await this.closeServer(id)
    this.oauth.delete(`${userId}:${id}`)
    return this.list()
  }
  //记录未完成的任务,返回原始任务
  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work)
    //不管是成功还是失败都取消登记
    void work.then(
        () => this.pending.delete(work),
        () => this.pending.delete(work))
    return work
  }

  private async connection(config: StoredMcpServer, scope: string, directory: string, context: string): Promise<McpConnection> {
    const userId = this.state.requireUser().id
    const version = this.version
    const existing = this.connections.find(
        c => c.userId === userId && c.serverId === config.id && c.scope === scope)
    if (existing) return existing.client
    const secretValues = config.encryptedSecrets ? JSON.parse(await this.secrets.decrypt(config.encryptedSecrets)) as Record<string, string> : {}
    const key = `${userId}:${config.id}`
    let oauth = this.oauth.get(key)
    if (config.auth === 'oauth' && !oauth) {
      const saved = config.encryptedOAuth ? await this.secrets.decrypt(config.encryptedOAuth) : undefined
      oauth = this.oauth.get(key) || new McpOAuth(saved, async value => {
        const encrypted = await this.secrets.encrypt(value)
        this.state.transaction(() => {
          const server = this.state.state.users.find(u => u.id === userId)?.mcpServers?.find(s => s.id === config.id && s.url === config.url && s.auth === 'oauth')
          if (server) server.encryptedOAuth = encrypted
        })
      })
    }
    if (version !== this.version || this.state.requireUser().id !== userId) throw new Error('MCP 配置已变化。')
    if (oauth) this.oauth.set(key, oauth)
    const raced = this.connections.find(c => c.userId === userId && c.serverId === config.id && c.scope === scope)
    if (raced) return raced.client
    const client = new McpConnection(config, directory, secretValues, oauth)
    this.connections.push({ userId, serverId: config.id, scope, context, client })
    return client
  }

  /** 每轮取得工具快照；未连接的服务不阻断其他服务和普通聊天。 */
  tools(conversationId: string, signal: AbortSignal): Promise<AgentTool[]> {
    return this.track((async () => {
      const conversation = this.state.conversation(conversationId)
      const configs = this.state.requireUser().mcpServers?.filter(s => s.enabled) || []
      const results = await Promise.allSettled(configs.map(async config => {
        const client = await this.connection(config, conversationId, conversation.directory, conversation.title)
        await client.connect(signal)
        signal.throwIfAborted()
        return client.tools
      }))
      signal.throwIfAborted()
      return results.flatMap(r => r.status === 'fulfilled' ? r.value : [])
    })())
  }

  async act(input: McpAction): Promise<McpServerView[]> {
    const user = this.state.requireUser()
    const server = user.mcpServers?.find(s => s.id === input?.id)
    if (!server || !['connect', 'disconnect', 'login', 'logout', 'delete', 'enable', 'disable'].includes(input.action))
      throw new Error('MCP 操作无效。')
    if (input.action === 'login' && server.auth !== 'oauth')
      throw new Error('该服务器未启用 OAuth。')
    await this.closeServer(server.id)
    if (input.action === 'delete' || input.action === 'enable' || input.action === 'disable' || input.action === 'logout') {
      this.state.transaction(() => {
        if (input.action === 'delete') user.mcpServers = user.mcpServers!.filter(s => s.id !== server.id)
        else if (input.action === 'logout') delete server.encryptedOAuth
        else server.enabled = input.action === 'enable'
      })
      this.oauth.delete(`${user.id}:${server.id}`)
    }
    if (input.action === 'connect' || input.action === 'login') {
      if (!server.enabled) throw new Error('请先启用服务器。')
      const conversation = this.state.state.conversations.find(
          c => c.id === this.state.state.activeConversationId && c.userId === user.id)
      const client = await this.connection(
          server, 'settings', conversation?.directory || this.defaultDirectory, '连接测试')
      // 登录和测试在后台进行，设置仍可关闭连接或取消登录。
      this.track(input.action === 'login' ? client.login(this.openUrl) : client.connect()).catch(() => {
        if (client.status === 'connecting') { client.status = 'failed'; client.error = '连接或登录失败，请重试。' }
      })
    }
    return this.list()
  }

  private async closeServer(id: string): Promise<void> {
    this.version++
    const userId = this.state.requireUser().id
    const closing = this.connections.filter(c => c.userId === userId && c.serverId === id)
    this.connections = this.connections.filter(c => !closing.includes(c))
    await Promise.all(closing.map(c => c.client.close()))
  }
  release(scope: string): void {
    const closing = this.connections.filter(c => c.scope === scope)
    this.connections = this.connections.filter(c => c.scope !== scope)
    this.track(Promise.all(closing.map(c => c.client.close()))).catch(() => undefined)
  }
  async closeAll(): Promise<void> {
    this.version++
    const closing = this.connections.splice(0)
    await Promise.all(closing.map(c => c.client.close()))
    await Promise.allSettled([...this.pending])
    this.oauth.clear()
  }
}
