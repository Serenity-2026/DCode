import { useEffect, useRef, useState } from 'react'
import { Alert, App, Button, Form, Input, Modal, Select, Switch } from 'antd'
import type { McpAction, McpConnectionStatus, McpServerDraft, McpServerView } from '../../../../shared/mcp'
import type { Result } from '../../../../shared/types'
import './mcp.css'

const statuses: Record<McpConnectionStatus, string> = { disconnected: '未连接', connecting: '连接中', connected: '已连接', 'needs-auth': '需要认证', failed: '连接失败', disabled: '已停用' }

export function McpSettings({ busy }: { busy: boolean }) {
  const { modal } = App.useApp()
  const [servers, setServers] = useState<McpServerView[]>([])
  const [editing, setEditing] = useState<McpServerView | 'new' | null>(null)
  const [inspecting, setInspecting] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const revision = useRef(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      const current = revision.current
      try {
        const result = await window.dcode.listMcpServers()
        if (!cancelled && current === revision.current) {
          if (result.ok) setServers(result.value)
          else setError(result.error)
        }
      } catch { if (!cancelled) setError('无法读取 MCP 服务器。') }
      if (!cancelled) timer = setTimeout(() => void refresh(), 1500)
    }
    if (!pending) void refresh()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [pending])

  async function run(operation: () => Promise<Result<McpServerView[]>>): Promise<boolean> {
    if (pending || busy) return false
    revision.current++; setPending(true); setError('')
    try {
      const result = await operation()
      if (mounted.current) {
        if (result.ok) setServers(result.value)
        else setError(result.error)
      }
      return result.ok
    } catch { if (mounted.current) setError('MCP 操作失败，请重试。'); return false }
    finally { if (mounted.current) setPending(false) }
  }
  const act = (id: string, action: McpAction['action']) => run(() => window.dcode.mcpAction({ id, action }))
  const selected = servers.find(s => s.id === inspecting)
  const tools = [...new Map(selected?.connections.flatMap(c => c.tools).map(t => [t.name, t]) || []).values()]

  return <div className="mcp-settings">
    <div className="mcp-toolbar"><Button type="primary" disabled={pending || busy} onClick={() => { setError(''); setEditing('new') }}>添加 MCP 服务器</Button></div>
    {error && <Alert type="error" showIcon title={error} />}
    {!servers.length && <p>尚未添加 MCP 服务器</p>}
    {servers.map(server => <article className="mcp-card" key={server.id} aria-label={`MCP ${server.name}`}>
      <div className="mcp-card-heading"><div><h3>{server.name}</h3><span>{server.transport === 'stdio' ? '本地进程 · stdio' : '远程服务 · Streamable HTTP'}</span></div><Switch aria-label={`启用 ${server.name}`} checked={server.enabled} disabled={pending || busy} onChange={value => void act(server.id, value ? 'enable' : 'disable')} /></div>
      <div className="mcp-connections">{!server.connections.length ? <span>{server.enabled ? '未连接' : '已停用'}</span> : server.connections.map((c, i) => <div key={i}><span>{c.context} · {statuses[c.status]} · {c.tools.length} 个工具</span>{c.error && <p role="status">{c.error}</p>}</div>)}</div>
      <div className="mcp-actions">
        <Button disabled={pending || busy || !server.enabled} onClick={() => void act(server.id, 'connect')}>连接 / 重连</Button>
        <Button disabled={pending || busy || !server.connections.length} onClick={() => void act(server.id, 'disconnect')}>断开</Button>
        {server.auth === 'oauth' && <><Button disabled={pending || busy || !server.enabled} onClick={() => void act(server.id, 'login')}>登录</Button><Button disabled={pending || busy} onClick={() => void act(server.id, 'logout')}>清除授权</Button></>}
        <Button disabled={!server.connections.some(c => c.tools.length)} onClick={() => setInspecting(server.id)}>查看工具</Button>
        <Button disabled={pending || busy} onClick={() => { setError(''); setEditing(server) }}>编辑</Button>
        <Button danger disabled={pending || busy} onClick={() => modal.confirm({ centered: true, title: `删除 ${server.name}？`, okText: '删除', cancelText: '取消', okButtonProps: { danger: true }, onOk: async () => { await act(server.id, 'delete') } })}>删除</Button>
      </div>
    </article>)}
    {editing && <McpEditor key={editing === 'new' ? 'new' : editing.id} server={editing === 'new' ? undefined : editing} pending={pending} busy={busy} error={error} onClose={() => setEditing(null)} onSave={async input => { if (await run(() => window.dcode.saveMcpServer(input))) setEditing(null) }} />}
    <Modal open={Boolean(selected)} centered title={`${selected?.name || ''} 的工具`} footer={null} onCancel={() => setInspecting(null)}><ul className="mcp-tool-list">{tools.map(tool => <li key={tool.name}><strong>{tool.name}</strong><p>{tool.description}</p></li>)}</ul></Modal>
  </div>
}

type EditorValues = Omit<McpServerDraft, 'args' | 'secrets'> & { argsText: string; secretsText: string }
function McpEditor({ server, pending, busy, error, onClose, onSave }: { server?: McpServerView; pending: boolean; busy: boolean; error: string; onClose: () => void; onSave: (input: McpServerDraft) => Promise<void> }) {
  const [form] = Form.useForm<EditorValues>()
  const [parseError, setParseError] = useState('')
  const transport = Form.useWatch('transport', form) || server?.transport || 'stdio'
  const auth = Form.useWatch('auth', form) || server?.auth || 'none'
  async function save(values: EditorValues) {
    try {
      const args: unknown = values.transport === 'stdio' ? JSON.parse(values.argsText || '[]') : []
      if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) throw new Error('启动参数必须是 JSON 字符串数组。')
      const secrets: unknown = values.transport === 'http' && values.auth !== 'headers' ? {} : values.secretsText?.trim() ? JSON.parse(values.secretsText) : undefined
      if (secrets !== undefined && (!secrets || typeof secrets !== 'object' || Array.isArray(secrets) || Object.values(secrets).some(v => typeof v !== 'string'))) throw new Error('凭据必须是 JSON 字符串键值对象。')
      setParseError('')
      await onSave({ id: server?.id, name: values.name, transport: values.transport, enabled: server?.enabled ?? true,
        command: values.transport === 'stdio' ? values.command : '', args: values.transport === 'stdio' ? args as string[] : [],
        url: values.transport === 'http' ? values.url : '', auth: values.transport === 'http' ? values.auth : 'none', secrets: secrets as Record<string, string> | undefined })
    } catch (cause) { setParseError(cause instanceof SyntaxError ? 'JSON 格式无效。' : (cause as Error).message) }
  }
  return <Modal open centered width={620} title={server ? '编辑 MCP 服务器' : '添加 MCP 服务器'} onCancel={onClose} footer={null} mask={{ closable: !pending }} closable={!pending} keyboard={!pending}>
    <Form form={form} layout="vertical" disabled={pending || busy} initialValues={{ name: server?.name || '', transport: server?.transport || 'stdio', command: server?.command || '', argsText: JSON.stringify(server?.args || []), url: server?.url || '', auth: server?.auth || 'none', secretsText: '' }} onFinish={values => void save(values)}>
      <Form.Item name="name" label="服务器名称" rules={[{ required: true, pattern: /^[\w-]{1,40}$/, message: '使用字母、数字、下划线或短横线，最多 40 个字符。' }]}><Input aria-label="MCP 名称" maxLength={40} /></Form.Item>
      <Form.Item name="transport" label="连接方式"><Select aria-label="MCP 连接方式" getPopupContainer={node => node.parentElement!} options={[{ value: 'stdio', label: '本地进程（stdio）' }, { value: 'http', label: '远程服务（Streamable HTTP）' }]} onChange={() => form.setFieldsValue({ secretsText: '' })} /></Form.Item>
      {transport === 'stdio' ? <>
        <Form.Item name="command" label="启动命令" rules={[{ required: true, message: '请输入可执行文件名称或路径。' }]}><Input aria-label="MCP 启动命令" placeholder="npx" /></Form.Item>
        <Form.Item name="argsText" label="启动参数（JSON 数组）"><Input.TextArea aria-label="MCP 启动参数" autoSize={{ minRows: 2, maxRows: 4 }} placeholder={'["-y", "服务器包名"]'} /></Form.Item>
      </> : <>
        <Form.Item name="url" label="服务地址" rules={[{ required: true, message: '请输入服务地址。' }]}><Input aria-label="MCP 服务地址" placeholder="https://example.com/mcp" /></Form.Item>
        <Form.Item name="auth" label="认证方式"><Select aria-label="MCP 认证方式" getPopupContainer={node => node.parentElement!} options={[{ value: 'none', label: '无认证' }, { value: 'headers', label: '请求头 / Token' }, { value: 'oauth', label: 'OAuth 浏览器登录' }]} /></Form.Item>
      </>}
      {(transport === 'stdio' || auth === 'headers') && <Form.Item name="secretsText" label={transport === 'stdio' ? '环境变量（JSON 对象）' : '请求头（JSON 对象）'}><Input.TextArea aria-label="MCP 凭据" autoComplete="off" autoSize={{ minRows: 2, maxRows: 4 }} placeholder={server?.hasSecrets ? '已保存；留空保留，填写 {} 清除' : transport === 'stdio' ? '{"API_KEY":"…"}' : '{"Authorization":"Bearer …"}'} /></Form.Item>}
      {(parseError || error) && <Alert type="error" title={parseError || error} showIcon />}
      <div className="mcp-actions"><Button onClick={onClose} disabled={pending}>取消</Button><Button type="primary" htmlType="submit" loading={pending}>保存 MCP 服务器</Button></div>
    </Form>
  </Modal>
}
