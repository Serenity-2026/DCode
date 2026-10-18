import { afterEach, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { readFileSync, realpathSync } from 'node:fs'
import { McpConnection } from '../../src/main/infrastructure/mcp/client'
import { McpOAuth } from '../../src/main/infrastructure/mcp/oauth'
import { mcpResult, mcpTool, mcpToolName } from '../../src/main/infrastructure/mcp/tools'
import { McpService } from '../../src/main/services/mcp-service'
import { StateRepository } from '../../src/main/repositories/state-repository'
import type { McpServerConfig } from '../../src/shared/mcp'
import { mcpHttp } from '../fixtures/mcp-http'
import { cleanup, create, secrets } from './helpers'
import { Agent } from '../../src/main/agent/agent'
import { AgentLoop } from '../../src/main/agent/agent-loop'
import { config as modelConfig } from './helpers'

const closing: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of closing.splice(0).reverse()) await close(); cleanup() })
const config = (url = ''): McpServerConfig => ({ id: 'server', name: 'docs', transport: 'http', command: '', args: [], url, auth: 'none', enabled: true })
async function http() { const h = await mcpHttp(); closing.push(h.close); return h }
function connection(c: McpServerConfig, directory = process.cwd(), env = {}, oauth?: McpOAuth) { const client = new McpConnection(c, directory, env, oauth); closing.push(() => client.close()); return client }

it('launches stdio in its workspace, discovers updates and reaps the process', async () => {
  const { directory } = await create()
  const client = connection({ ...config(), transport: 'stdio', command: process.execPath, args: [resolve('tests/fixtures/mcp-stdio.mjs')] }, directory, { MCP_TEST_SECRET: 'fixture-secret' })
  await client.connect()
  expect(client.status).toBe('connected')
  const result = await client.tools[0].execute({}, new AbortController().signal)
  const data = JSON.parse((result.content[0] as { text: string }).text)
  expect(data).toMatchObject({ cwd: realpathSync(directory), secret: 'fixture-secret' })
  await expect.poll(() => client.tools.map(t => t.name)).toEqual([mcpToolName('docs', 'updated')])
  await client.close()
  await expect.poll(() => { try { process.kill(data.pid, 0); return false } catch { return true } }).toBe(true)
})

it('uses HTTP headers, aggregates paginated tools, preserves structured errors, and never replays calls', async () => {
  const h = await http()
  h.state.auth = true; h.state.bearer = 'header-secret'
  const client = connection({ ...config(`${h.url}/mcp`), auth: 'headers' }, process.cwd(), { Authorization: 'Bearer header-secret' })
  await Promise.all([client.connect(), client.connect()])
  expect(h.requests.filter(r => r.method === 'initialize')).toHaveLength(1)
  expect(client.tools).toHaveLength(2)
  const result = await client.tools[0].execute({ text: 'error' }, new AbortController().signal)
  expect(result).toMatchObject({ isError: true, structuredContent: { echoed: 'error' }, content: [{ type: 'text', text: 'MCP:error' }] })
  h.state.failCalls = true
  await expect(client.tools[0].execute({ text: 'once' }, new AbortController().signal)).rejects.toThrow('调用失败')
  expect(h.requests.filter(r => r.method === 'tools/call' && (r.params?.arguments as { text: string }).text === 'once')).toHaveLength(1)
  await client.close()
  expect(h.state.closed).toBe(1)
})

it('cancels a running HTTP call and sends the protocol cancellation', async () => {
  const h = await http()
  const client = connection(config(`${h.url}/mcp`))
  await client.connect()
  const controller = new AbortController()
  const call = client.tools[1].execute({}, controller.signal)
  void call.catch(() => undefined)
  await expect.poll(() => h.requests.some(r => r.method === 'tools/call')).toBe(true)
  controller.abort()
  await expect(call).rejects.toThrow()
  await expect.poll(() => h.requests.some(r => r.method === 'notifications/cancelled')).toBe(true)
})

it('retries transient connection failures and stops retrying after close', async () => {
  const h = await http()
  h.state.failInitialize = true
  const client = connection(config(`${h.url}/mcp`))
  await expect(client.connect()).rejects.toThrow()
  h.state.failInitialize = false
  await expect.poll(() => client.status, { timeout: 5000 }).toBe('connected')
  await client.close()
  await expect(client.connect()).rejects.toThrow('已关闭')
})

it('authorizes only on explicit login with state and PKCE, then reuses saved OAuth credentials', async () => {
  const h = await http()
  h.state.auth = true
  let saved: string | undefined
  const oauth = new McpOAuth(undefined, async value => { saved = value })
  const client = connection({ ...config(`${h.url}/mcp`), auth: 'oauth' }, process.cwd(), {}, oauth)
  await expect(client.connect()).rejects.toThrow()
  expect(h.state.registrations).toBe(0)
  expect(client.status).toBe('needs-auth')
  await client.login(async address => {
    const url = new URL(address)
    h.state.challenge = url.searchParams.get('code_challenge')!
    const redirect = new URL(url.searchParams.get('redirect_uri')!)
    redirect.search = new URLSearchParams({ code: 'fixture-code', state: 'wrong', iss: h.url }).toString()
    expect((await fetch(redirect)).status).toBe(400)
    redirect.searchParams.set('state', url.searchParams.get('state')!)
    expect((await fetch(redirect)).status).toBe(200)
  })
  expect(client.status).toBe('connected')
  expect(h.state.verifier).toBeTruthy()
  expect(saved).toContain('oauth-fixture-secret')
  await client.close()
  const restored = connection({ ...config(`${h.url}/mcp`), auth: 'oauth' }, process.cwd(), {}, new McpOAuth(saved, async () => {}))
  await restored.connect()
  expect(h.state.registrations).toBe(1)
  expect(h.state.tokens).toBe(1)
})

it('isolates account configs, encrypts secrets, rejects invalid input and clears credentials when endpoint changes', async () => {
  const { store, directory, path, auth } = await create()
  const service = new McpService(store, secrets, directory, async () => {})
  closing.push(() => service.closeAll())
  const h = await http()
  const draft = { ...config(`${h.url}/mcp`), id: undefined, auth: 'headers' as const, secrets: { Authorization: 'Bearer private-value' } }
  const view = (await service.save(draft))[0]
  expect(JSON.stringify(view)).not.toContain('private-value')
  expect(readFileSync(path, 'utf8')).not.toContain('private-value')
  expect(new StateRepository(path).state.users[0].mcpServers).toHaveLength(1)
  await expect(service.save({ ...draft, name: 'bad name' })).rejects.toThrow('配置无效')
  await expect(service.save({ ...draft, name: 'other', url: 'file:///tmp/foo' })).rejects.toThrow('配置无效')
  await service.save({ ...draft, id: view.id, secrets: undefined, url: `${h.url}/changed` })
  expect(service.list()[0].hasSecrets).toBe(false)
  await auth.logout()
  expect(() => service.list()).toThrow('请先登录')
  await auth.register({ username: 'second', password: 'test-password' })
  expect(service.list()).toEqual([])
})

it('isolates conversation connections and closes every connection when deleting a server', async () => {
  const { store, directory } = await create()
  const h = await http()
  const service = new McpService(store, secrets, directory, async () => {})
  closing.push(() => service.closeAll())
  const [server] = await service.save({ ...config(`${h.url}/mcp`), id: undefined })
  const first = store.state.activeConversationId!
  store.createConversation(directory)
  const second = store.state.activeConversationId!
  await Promise.all([service.tools(first, new AbortController().signal), service.tools(second, new AbortController().signal)])
  expect(service.list()[0].connections).toHaveLength(2)
  await service.act({ id: server.id, action: 'delete' })
  expect(service.list()).toEqual([])
  expect(await service.tools(first, new AbortController().signal)).toEqual([])
})

it('bounds model content, hides metadata and keeps names collision-resistant', async () => {
  const result = mcpResult({ content: [{ type: 'text', text: 'x'.repeat(30_000) }], _meta: { secret: 'hidden' } })
  expect(JSON.stringify(result.content)).toContain('截断')
  expect(JSON.stringify(mcpResult({ content: [{ type: 'text', text: 'x'.repeat(24_000) }, { type: 'text', text: 'overflow' }] }).content)).toContain('截断')
  expect(JSON.stringify(result).length).toBeLessThan(25_000)
  expect(JSON.stringify(result)).not.toContain('hidden')
  expect(mcpToolName('docs', 'a.b')).not.toBe(mcpToolName('docs', 'a/b'))
  expect(mcpToolName('docs', 'x'.repeat(200)).length).toBeLessThanOrEqual(64)
  expect(mcpTool('docs', { name: 'url', inputSchema: { type: 'object', properties: { url: { type: 'string', format: 'uri' } } } }, async () => ({ content: [] }))).toBeDefined()
})

it('stops discovery immediately and allows a later connection without leaking the old transport', async () => {
  const h = await http()
  h.state.holdInitialize = true
  const client = connection(config(`${h.url}/mcp`))
  const controller = new AbortController()
  const pending = client.connect(controller.signal)
  void pending.catch(() => undefined)
  await expect.poll(() => h.requests.some(r => r.method === 'initialize')).toBe(true)
  controller.abort()
  await expect(pending).rejects.toThrow()
  expect(client.status).toBe('disconnected')
  h.state.holdInitialize = false
  await client.connect()
  expect(client.status).toBe('connected')
})

it('cancels browser sign-in and closes its loopback listener', async () => {
  const h = await http()
  h.state.auth = true
  const oauth = new McpOAuth(undefined, async () => {})
  const client = connection({ ...config(`${h.url}/mcp`), auth: 'oauth' }, process.cwd(), {}, oauth)
  let callback = ''
  const login = client.login(async address => { callback = new URL(address).searchParams.get('redirect_uri')! })
  void login.catch(() => undefined)
  await expect.poll(() => Boolean(callback)).toBe(true)
  await client.close()
  await expect(login).rejects.toThrow('取消')
  await expect(fetch(callback)).rejects.toThrow()
})

it('classifies rejected static credentials without exposing server responses', async () => {
  const h = await http()
  h.state.auth = true; h.state.bearer = 'expected'
  const client = connection({ ...config(`${h.url}/mcp`), auth: 'headers' }, process.cwd(), { Authorization: 'Bearer wrong-secret' })
  await expect(client.connect()).rejects.toThrow()
  expect(client.status).toBe('needs-auth')
  expect(client.error).not.toContain('wrong-secret')
})

it('refreshes the Agent tool snapshot between prompts and reports MCP usage through the normal loop', async () => {
  const h = await http()
  const client = connection(config(`${h.url}/mcp`))
  let enabled = true
  const seen: string[][] = []
  const usage: unknown[] = []
  const agent = new Agent(new AgentLoop(async (_config, messages, _controller, _delta, tools) => {
    seen.push(tools.map(t => t.name))
    if (tools.length && messages.at(-1)?.role === 'user') return { role: 'assistant', stopReason: 'toolCall', content: [{ type: 'toolCall', id: 'mcp', name: tools[0].name, arguments: { text: 'agent' } }] }
    return { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] }
  }), [], async signal => { if (!enabled) return []; await client.connect(signal); return client.tools })
  agent.subscribe(event => { if (event.type === 'tool_execution_start') usage.push(event.usageIdentity) })
  await agent.prompt(modelConfig, { role: 'user', content: 'first' })
  expect(agent.state.messages.some(m => m.role === 'toolResult' && m.content.some(c => c.type === 'text' && c.text === 'MCP:agent'))).toBe(true)
  expect(usage).toEqual([{ kind: 'mcp', name: 'docs/echo' }])
  enabled = false
  await agent.prompt(modelConfig, { role: 'user', content: 'second' })
  expect(seen.at(-1)).toEqual([])
})
