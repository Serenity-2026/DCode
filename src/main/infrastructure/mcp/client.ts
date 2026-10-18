import { pathToFileURL } from 'node:url'
import { Client, StreamableHTTPClientTransport, UnauthorizedError, SdkHttpError, type CallToolResult, type Tool } from '@modelcontextprotocol/client'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio'
import type { McpConnectionStatus, McpServerConfig } from '../../../shared/mcp'
import type { AgentTool } from '../../domain/llm'
import { mcpTool, mcpToolName } from './tools'
import type { McpOAuth } from './oauth'

/** 一个目录中的一个服务器连接；不依赖 Electron、应用状态或 UI。 */
export class McpConnection {
  status: McpConnectionStatus = 'disconnected'
  error?: string
  tools: AgentTool[] = []
  private client?: Client
  private transport?: StdioClientTransport | StreamableHTTPClientTransport
  private opening?: Promise<void>
  private signingIn?: Promise<void>
  private closing?: Promise<void>
  private readonly lifetime = new AbortController()
  private retryTimer?: ReturnType<typeof setTimeout>
  private retries = 0

  constructor(readonly config: McpServerConfig, readonly directory: string, private readonly secrets: Record<string, string>, private readonly oauth?: McpOAuth) {}

  connect(signal?: AbortSignal): Promise<void> {
    if (this.closing || this.lifetime.signal.aborted) return Promise.reject(new Error('MCP 连接已关闭。'))
    if (this.status === 'connected') return Promise.resolve()
    if (this.oauth && !this.oauth.tokens() && !this.oauth.interactive) {
      this.status = 'needs-auth'; this.error = '请点击登录完成 OAuth 授权。'
      return Promise.reject(new UnauthorizedError())
    }
    if (this.opening) return this.opening
    clearTimeout(this.retryTimer)
    this.opening = this.open(signal).finally(() => { this.opening = undefined })
    return this.opening
  }

  private async open(signal?: AbortSignal): Promise<void> {
    const abort = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])])
    abort.throwIfAborted()
    this.status = 'connecting'; this.error = undefined
    const previous = this.client
    this.client = undefined
    await previous?.close().catch(() => undefined)
    abort.throwIfAborted()
    const client = new Client({ name: 'DCode', version: '0.1.0' }, {
      capabilities: { roots: { listChanged: false } },
      listChanged: { tools: { onChanged: (error, tools) => {
        if (!error && tools && this.client === client && this.status === 'connected') this.installTools(tools)
      } } }
    })
    this.client = client
    client.setRequestHandler('roots/list', async () => ({ roots: [{ uri: pathToFileURL(this.directory).href }] }))
    client.onclose = () => {
      if (this.client !== client || this.lifetime.signal.aborted || this.status !== 'connected') return
      this.client = undefined; this.status = 'disconnected'
      this.error = '连接已断开。'
      this.scheduleReconnect()
    }
    const transport = this.transport = this.config.transport === 'stdio'
      ? new StdioClientTransport({ command: this.config.command, args: this.config.args, cwd: this.directory, env: { ...getDefaultEnvironment(), ...this.secrets }, stderr: 'ignore' })
      : new StreamableHTTPClientTransport(new URL(this.config.url), {
        requestInit: { headers: this.config.auth === 'headers' ? this.secrets : {} }, authProvider: this.oauth,
        fetch: async (input, init) => {
          const timeout = new AbortController()
          const timer = setTimeout(() => timeout.abort(), 10_000)
          try { return await fetch(input, { ...init, signal: AbortSignal.any([timeout.signal, this.lifetime.signal, ...(init?.signal ? [init.signal] : [])]) }) }
          finally { clearTimeout(timer) }
        }
      })
    const cancel = (): void => { void client.close().catch(() => undefined) }
    abort.addEventListener('abort', cancel, { once: true })
    try {
      await client.connect(transport, { signal: abort, timeout: 10_000 })
      const result = await client.listTools(undefined, { signal: abort, timeout: 10_000 })
      abort.throwIfAborted()
      this.installTools(result.tools)
      this.status = 'connected'; this.retries = 0
    } catch (error) {
      this.client = undefined
      await client.close().catch(() => undefined)
      this.status = abort.aborted ? 'disconnected' : error instanceof UnauthorizedError || error instanceof SdkHttpError && [401, 403].includes(error.status) ? 'needs-auth' : 'failed'
      this.error = this.status === 'needs-auth' ? '请登录或检查认证配置。' : abort.aborted ? undefined : '连接失败，请检查启动命令、服务地址和凭据。'
      if (!abort.aborted && this.status === 'failed' && (error instanceof TypeError || error instanceof SdkHttpError && (error.status === 429 || error.status >= 500))) this.scheduleReconnect()
      throw error
    } finally { abort.removeEventListener('abort', cancel) }
  }

  private installTools(tools: Tool[]): void {
    const accepted: AgentTool[] = []
    let invalid = 0
    for (const tool of tools) {
      try { accepted.push(mcpTool(this.config.name, tool, (name, args, signal) => this.call(name, args, signal))) }
      catch { invalid++ }
    }
    this.tools = accepted
    this.error = invalid ? `${invalid} 个工具的参数定义无效，已跳过。` : undefined
  }

  private scheduleReconnect(): void {
    if (this.config.transport !== 'http' || this.lifetime.signal.aborted || this.retries >= 3) return
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => { void this.connect().catch(() => undefined) }, 1000 * 2 ** this.retries++)
    this.retryTimer.unref()
  }

  async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
    signal.throwIfAborted()
    await this.connect(signal)
    if (!this.tools.some(tool => tool.name === mcpToolName(this.config.name, name))) throw new Error('MCP 工具已移除。')
    // 不重放 tools/call；失败前服务可能已经产生副作用。
    try { return await this.client!.callTool({ name, arguments: args }, { signal: AbortSignal.any([signal, this.lifetime.signal]), timeout: 60_000, maxTotalTimeout: 60_000 }) }
    catch (error) {
      if (error instanceof UnauthorizedError || error instanceof SdkHttpError && [401, 403].includes(error.status)) { this.status = 'needs-auth'; this.error = '请重新登录或检查凭据。' }
      else if (!signal.aborted && (error instanceof SdkHttpError || error instanceof TypeError)) { this.status = 'failed'; this.error = '服务器请求失败，请重连后重试。' }
      throw error
    }
  }

  login(openUrl: (url: string) => Promise<void>): Promise<void> {
    if (this.signingIn) return this.signingIn
    this.signingIn = this.signIn(openUrl).finally(() => { this.signingIn = undefined })
    return this.signingIn
  }

  private async signIn(openUrl: (url: string) => Promise<void>): Promise<void> {
    if (!this.oauth) throw new Error('该服务器未启用 OAuth。')
    this.status = 'connecting'; this.error = undefined
    await this.oauth.login(this.lifetime.signal, openUrl, async callback => {
      try { await this.connect() }
      catch (error) {
        if (!(error instanceof UnauthorizedError) || !(this.transport instanceof StreamableHTTPClientTransport)) throw error
        this.status = 'connecting'; this.error = undefined
        const params = await callback
        this.lifetime.signal.throwIfAborted()
        await this.transport.finishAuth(params)
        await this.connect()
      }
    })
  }

  close(): Promise<void> {
    return this.closing ||= this.shutdown()
  }

  private async shutdown(): Promise<void> {
    clearTimeout(this.retryTimer)
    this.status = 'disconnected'; this.tools = []
    // 终止已建立的远程会话；不允许失联服务器拖住应用退出。
    if (!this.opening && !this.signingIn && this.transport instanceof StreamableHTTPClientTransport && this.transport.sessionId) {
      const timer = setTimeout(() => this.lifetime.abort(), 1000)
      try { await this.transport.terminateSession().catch(() => undefined) }
      finally { clearTimeout(timer) }
    }
    this.lifetime.abort()
    await this.client?.close().catch(() => undefined)
    await this.opening?.catch(() => undefined)
    await this.signingIn?.catch(() => undefined)
    await this.oauth?.settled()
  }
}
