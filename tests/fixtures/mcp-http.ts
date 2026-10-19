import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'

/** 真实 HTTP 测试服务器；覆盖分页、认证、取消和工具错误，不依赖付费服务。 */
export async function mcpHttp(options: { beforeListTools?: () => Promise<void> } = {}) {
  const requests: { method?: string; params?: Record<string, unknown>; authorization?: string }[] = []
  const state = { auth: false, bearer: '', failCalls: false, failInitialize: false, holdInitialize: false, challenge: '', verifier: '', registrations: 0, tokens: 0, closed: 0 }
  let url = ''
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, url).pathname
    const json = (value: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)) }
    if (path.includes('.well-known/oauth-protected-resource')) return json({ resource: `${url}/mcp`, authorization_servers: [url] })
    if (path.includes('.well-known/oauth-authorization-server')) return json({ issuer: url, authorization_endpoint: `${url}/authorize`, token_endpoint: `${url}/token`, registration_endpoint: `${url}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true })
    let body = ''
    for await (const chunk of request) body += chunk
    if (path === '/register') { state.registrations++; return json({ ...JSON.parse(body), client_id: 'fixture-client' }, 201) }
    if (path === '/token') {
      state.tokens++
      const fields = new URLSearchParams(body)
      state.verifier = fields.get('code_verifier') || ''
      if (fields.get('grant_type') !== 'refresh_token' && createHash('sha256').update(state.verifier).digest('base64url') !== state.challenge) return json({ error: 'invalid_grant' }, 400)
      state.bearer = 'oauth-fixture-secret'
      return json({ access_token: state.bearer, refresh_token: 'refresh-fixture-secret', token_type: 'Bearer', expires_in: 3600 })
    }
    if (path !== '/mcp') return json({}, 404)
    if (state.auth && request.headers.authorization !== `Bearer ${state.bearer || 'not-authorized'}`) {
      response.setHeader('WWW-Authenticate', `Bearer resource_metadata="${url}/.well-known/oauth-protected-resource/mcp"`)
      return json({}, 401)
    }
    if (request.method === 'GET') { response.writeHead(405).end(); return }
    if (request.method === 'DELETE') { state.closed++; response.writeHead(204).end(); return }
    const message = JSON.parse(body)
    requests.push({ ...message, authorization: request.headers.authorization })
    if (message.id === undefined) { response.writeHead(202).end(); return }
    if (message.method === 'tools/list') await options.beforeListTools?.()
    let result: unknown = {}
    if (message.method === 'initialize') {
      if (state.holdInitialize) return
      if (state.failInitialize) return json({}, 503)
      response.setHeader('Mcp-Session-Id', 'fixture-session')
      result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'http-fixture', version: '1' } }
    } else if (message.method === 'tools/list') result = message.params?.cursor ? { tools: [{ name: 'wait', inputSchema: { type: 'object', properties: {} } }] } : {
      tools: [{ name: 'echo', description: 'Echo MCP input', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }], nextCursor: 'page2'
    }
    else if (message.method === 'tools/call') {
      if (state.failCalls) return json({ error: 'secret-upstream-error' }, 503)
      if (message.params.name === 'wait') return
      result = { content: [{ type: 'text', text: `MCP:${message.params.arguments.text}` }], structuredContent: { echoed: message.params.arguments.text }, isError: message.params.arguments.text === 'error' }
    }
    json({ jsonrpc: '2.0', id: message.id, result })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, requests, state, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}
