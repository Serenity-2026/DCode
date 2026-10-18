import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { UnauthorizedError, type OAuthClientProvider, type OAuthClientInformationContext, type StoredOAuthClientInformation, type StoredOAuthTokens, type OAuthDiscoveryState } from '@modelcontextprotocol/client'
import { validMcpUrl } from '../../../shared/mcp'

interface OAuthState {
  redirectUrl?: string
  clients: Record<string, StoredOAuthClientInformation>
  tokens: Record<string, StoredOAuthTokens>
  issuer?: string
  discovery?: OAuthDiscoveryState
}

/** SDK 负责 OAuth 协议，本类只负责系统浏览器、回环回调与加密存储接口。 */
export class McpOAuth implements OAuthClientProvider {
  private data: OAuthState
  private verifier?: string
  private nonce?: string
  private listener?: Server
  private openUrl?: (url: string) => Promise<void>
  private saving: Promise<void> = Promise.resolve()

  constructor(saved: string | undefined, private readonly save: (value: string) => Promise<void>) {
    this.data = saved ? JSON.parse(saved) as OAuthState : { clients: {}, tokens: {} }
  }
  get redirectUrl(): string { return this.data.redirectUrl || 'http://127.0.0.1/callback' }
  get interactive(): boolean { return Boolean(this.openUrl) }
  get clientMetadata() { return { client_name: 'DCode', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', application_type: 'native' as const } }
  state(): string { return this.nonce = randomUUID() }
  clientInformation(ctx?: OAuthClientInformationContext) { return ctx ? this.data.clients[ctx.issuer] : undefined }
  async saveClientInformation(info: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext): Promise<void> {
    if (!ctx) throw new Error('OAuth 缺少授权服务器标识。')
    this.data.clients[ctx.issuer] = info
    await this.persist()
  }
  tokens(ctx?: OAuthClientInformationContext) { return this.data.tokens[ctx?.issuer || this.data.issuer || ''] }
  async saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
    const issuer = ctx?.issuer || this.data.issuer
    if (!issuer) throw new Error('OAuth 缺少授权服务器标识。')
    this.data.issuer = issuer
    this.data.tokens[issuer] = tokens
    await this.persist()
  }
  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.openUrl) throw new UnauthorizedError()
    if (!validMcpUrl(url.href)) throw new Error('OAuth 授权地址无效。')
    await this.openUrl(url.href)
  }
  saveCodeVerifier(value: string): void { this.verifier = value }
  codeVerifier(): string { if (!this.verifier) throw new Error('OAuth 登录已过期。'); return this.verifier }
  discoveryState() { return this.data.discovery }
  async saveDiscoveryState(value: OAuthDiscoveryState): Promise<void> { this.data.discovery = value; await this.persist() }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all' || scope === 'client') this.data.clients = {}
    if (scope === 'all' || scope === 'tokens') { this.data.tokens = {}; delete this.data.issuer }
    if (scope === 'all' || scope === 'discovery') delete this.data.discovery
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined
    await this.persist()
  }
  private persist(): Promise<void> {
    const value = JSON.stringify(this.data)
    this.saving = this.saving.catch(() => undefined).then(() => this.save(value))
    return this.saving
  }
  async settled(): Promise<void> { await this.saving }

  /** 只有用户点击登录才监听端口、打开浏览器；取消或超时一定关闭回调服务器。 */
  async login<T>(signal: AbortSignal, openUrl: (url: string) => Promise<void>, run: (callback: Promise<URLSearchParams>) => Promise<T>): Promise<T> {
    if (this.listener) throw new Error('正在等待浏览器登录。')
    signal.throwIfAborted()
    let accept!: (params: URLSearchParams) => void
    let reject!: (error: Error) => void
    const callback = new Promise<URLSearchParams>((resolve, fail) => { accept = resolve; reject = fail })
    void callback.catch(() => undefined)
    const listener = this.listener = createServer((request, response) => {
      const url = new URL(request.url || '/', this.redirectUrl)
      if (request.method !== 'GET' || url.pathname !== '/callback' || !this.nonce || url.searchParams.get('state') !== this.nonce) {
        response.writeHead(400).end('Invalid callback'); return
      }
      if (!url.searchParams.get('code') || url.searchParams.has('error')) {
        response.writeHead(400).end('Authorization declined'); reject(new Error('OAuth 登录被拒绝。')); return
      }
      this.nonce = undefined
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('授权已接收，可以返回 DCode。')
      accept(url.searchParams)
    })
    const abort = (): void => { reject(new Error('OAuth 登录已取消。')); listener.close(); listener.closeAllConnections() }
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => { reject(new Error('OAuth 登录超时。')); listener.close(); listener.closeAllConnections() }, 120_000)
    try {
      await new Promise<void>((resolve, fail) => {
        listener.once('error', fail)
        listener.listen(this.data.redirectUrl ? Number(new URL(this.data.redirectUrl).port) : 0, '127.0.0.1', () => resolve())
      })
      signal.throwIfAborted()
      this.data.redirectUrl = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/callback`
      this.openUrl = openUrl
      return await run(callback)
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      this.openUrl = undefined; this.verifier = undefined; this.nonce = undefined; this.listener = undefined
      listener.close(); listener.closeAllConnections()
      await this.settled()
    }
  }
}
