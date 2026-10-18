/** MCP 配置的公开部分。环境变量、请求头和 OAuth 状态仅在主进程加密保存。 */
export interface McpServerConfig {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command: string
  args: string[]
  url: string
  auth: 'none' | 'headers' | 'oauth'
  enabled: boolean
}
export interface McpServerDraft extends Omit<McpServerConfig, 'id'> {
  id?: string
  /** undefined 保留原值；空对象清除。stdio 为 env，HTTP 为 headers。 */
  secrets?: Record<string, string>
}
export type McpConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'needs-auth' | 'failed' | 'disabled'
export interface McpServerView extends McpServerConfig {
  hasSecrets: boolean
  connections: { context: string; status: McpConnectionStatus; error?: string; tools: { name: string; description: string }[] }[]
}
export interface McpAction { id: string; action: 'connect' | 'disconnect' | 'login' | 'logout' | 'delete' | 'enable' | 'disable' }

export function validMcpConfig(value: unknown): value is McpServerConfig {
  if (!value || typeof value !== 'object') return false
  const v = value as McpServerConfig
  return typeof v.id === 'string' && Boolean(v.id) && typeof v.name === 'string' && /^[\w-]{1,40}$/.test(v.name)
    && ['stdio', 'http'].includes(v.transport) && typeof v.enabled === 'boolean'
    && ['none', 'headers', 'oauth'].includes(v.auth) && typeof v.command === 'string' && v.command.length <= 2048 && !v.command.includes('\0')
    && Array.isArray(v.args) && v.args.length <= 100 && v.args.every(a => typeof a === 'string' && a.length <= 8192 && !a.includes('\0'))
    && typeof v.url === 'string' && v.url.length <= 2048
    && (v.transport === 'stdio' ? Boolean(v.command.trim()) && v.auth === 'none' : validMcpUrl(v.url))
}

export function validMcpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return !url.username && !url.password && !url.hash && (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  } catch { return false }
}
