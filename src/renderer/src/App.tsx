import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Alert, App as AntApp, Button, ConfigProvider, Dropdown, Input, Modal, Segmented, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import {
  ArrowUpOutlined, PlusOutlined, SearchOutlined, MessageOutlined, MoreOutlined,
  SettingOutlined, CodeOutlined, BugOutlined, BranchesOutlined, CopyOutlined,
  ReloadOutlined, StopOutlined, CheckOutlined, DeleteOutlined, EditOutlined,
  DownOutlined, RightOutlined, ThunderboltOutlined
} from '@ant-design/icons'
import type { Action, Message, Snapshot, StreamEvent } from '../../shared/types'
import { Markdown } from './Markdown'

function Mark(): ReactNode {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="m8 6-5 6 5 6m8-12 5 6-5 6M14 4l-4 16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

export default function Root(): ReactNode {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    void window.dcode.getState().then(result => {
      if (result.ok) setSnapshot(result.value)
      else setError(result.error)
    }).catch(() => setError('无法连接桌面服务，请重启应用。'))
  }, [])
  const dark = snapshot?.theme === 'dark'
  return <ConfigProvider locale={zhCN} theme={{
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: { colorPrimary: dark ? '#8ac8a3' : '#303b33', borderRadius: 8, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif' }
  }}><AntApp>
    {snapshot ? <Workspace snapshot={snapshot} setSnapshot={setSnapshot} /> : error ? <div className="load-error"><Alert title={error} type="error" showIcon /></div> : <div className="loading">正在打开工作台…</div>}
  </AntApp></ConfigProvider>
}

function Workspace({ snapshot, setSnapshot }: { snapshot: Snapshot; setSnapshot: React.Dispatch<React.SetStateAction<Snapshot | null>> }): ReactNode {
  const { message: toast, modal } = AntApp.useApp()
  const [draft, setDraft] = useState('')
  const [search, setSearch] = useState('')
  const [pending, setPending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [usersOpen, setUsersOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [edit, setEdit] = useState<{ type: 'user' | 'conversation'; id: string; value: string } | null>(null)
  const streamEvents = useRef(new Map<string, StreamEvent>())
  const scroll = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const composer = useRef<React.ComponentRef<typeof Input.TextArea>>(null)
  const inFlight = useRef(false)
  const user = snapshot.users.find(u => u.id === snapshot.activeUserId)!
  const active = snapshot.conversations.find(c => c.id === snapshot.activeConversationId)
  const generating = Boolean(active?.messages.some(m => m.status === 'streaming'))
  const busy = generating || pending || stopping

  const installSnapshot = useCallback((next: Snapshot): void => {
    for (const c of next.conversations) c.messages = c.messages.map(m => streamEvents.current.get(m.id)?.message || m)
    setSnapshot(next)
  }, [setSnapshot])

  useEffect(() => window.dcode.onStream(event => {
    streamEvents.current.set(event.message.id, event)
    setSnapshot(previous => previous ? {
      ...previous,
      conversations: previous.conversations.map(c => c.id === event.conversationId ? {
        ...c,
        updatedAt: event.message.status === 'streaming' ? c.updatedAt : new Date().toISOString(),
        messages: c.messages.map(m => m.id === event.message.id ? event.message : m)
      } : c)
    } : previous)
  }), [setSnapshot])

  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [active?.messages, active?.id])

  const act = useCallback(async (action: Action): Promise<boolean> => {
    if (inFlight.current) return false
    inFlight.current = true
    setPending(true)
    try {
      const result = await window.dcode.action(action)
      if (!result.ok) { void toast.error(result.error); return false }
      streamEvents.current.clear()
      installSnapshot(result.value)
      if (['user:create', 'user:switch', 'user:delete', 'conversation:select', 'conversation:delete'].includes(action.type)) {
        setDraft(''); follow.current = true
      }
      return true
    } catch { void toast.error('操作失败，请重试。'); return false }
    finally { inFlight.current = false; setPending(false) }
  }, [installSnapshot, toast])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        if (!busy) void act({ type: 'conversation:select', id: null }).then(() => composer.current?.focus())
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [act, busy])

  async function send(retry = false): Promise<void> {
    if (busy || inFlight.current || (!retry && !draft.trim())) return
    inFlight.current = true
    setPending(true)
    follow.current = true
    streamEvents.current.clear()
    try {
      const result = await window.dcode.send({ content: draft, retry })
      if (result.ok) { installSnapshot(result.value); if (!retry) setDraft('') }
      else void toast.error(result.error)
    } catch { void toast.error('发送失败，请重试。') }
    finally { inFlight.current = false; setPending(false); composer.current?.focus() }
  }

  async function stop(): Promise<void> {
    if (stopping) return
    setStopping(true)
    try {
      const result = await window.dcode.stop()
      if (result.ok) installSnapshot(result.value)
      else void toast.error(result.error)
    } catch { void toast.error('停止失败，请重试。') }
    finally { setStopping(false) }
  }

  function confirmDelete(type: 'user' | 'conversation', id: string, name: string): void {
    modal.confirm({
      title: type === 'user' ? `删除用户“${name}”？` : '删除这段对话？',
      content: type === 'user' ? '该用户的全部对话也会被删除。' : name,
      okText: '删除', cancelText: '取消', okButtonProps: { danger: true },
      onOk: async () => { if (!await act({ type: type === 'user' ? 'user:delete' : 'conversation:delete', id })) throw new Error('删除失败') }
    })
  }

  function renderAssistant(m: Message, last: boolean): ReactNode {
    return <div className="assistant-content">
      {m.reasoning && <details className="reasoning"><summary>思考过程</summary><p>{m.reasoning}</p></details>}
      {m.content ? <Markdown content={m.content} /> : m.status === 'streaming' ? <div className="thinking-dots" aria-label="正在生成"><i /><i /><i /></div> : null}
      {m.status === 'error' && <Alert title={m.error || '生成失败，请重试。'} type="error" showIcon />}
      {m.status === 'stopped' && <div className="message-status">已停止生成</div>}
      {m.status !== 'streaming' && <div className="message-actions">
        {m.content && <Button type="text" size="small" icon={<CopyOutlined />} aria-label="复制回复" onClick={() => {
          void navigator.clipboard.writeText(m.content).then(() => toast.success('已复制')).catch(() => toast.error('复制失败。'))
        }} />}
        {last && <Button type="text" size="small" icon={<ReloadOutlined />} disabled={busy} onClick={() => void send(true)}>重新生成</Button>}
      </div>}
    </div>
  }

  const conversations = snapshot.conversations.filter(c => `${c.title} ${c.messages.map(m => m.content).join(' ')}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const modelName = snapshot.config.model
  return <div className="shell" data-theme={snapshot.theme}>
    <aside className="sidebar">
      <div className="window-space" />
      <div className="brand"><span className="brand-mark"><Mark /></span><span className="brand-name">DCode</span><span className="brand-version">0.1</span></div>
      <Button className="new-chat" icon={<PlusOutlined />} disabled={busy} onClick={() => void act({ type: 'conversation:select', id: null }).then(() => composer.current?.focus())}>新对话 <kbd className="shortcut">⌘ N</kbd></Button>
      <Input className="search" prefix={<SearchOutlined />} placeholder="搜索对话" aria-label="搜索对话" variant="borderless" allowClear value={search} onChange={e => setSearch(e.target.value)} />
      <div className="section-label"><span>最近对话</span><span>{snapshot.conversations.length ? snapshot.conversations.length : ''}</span></div>
      <nav className="history" aria-label="会话列表">
        {!conversations.length && <div className="history-empty">{search ? '没有找到对话' : '暂无对话'}</div>}
        {conversations.map(c => <div className={`history-item${c.id === active?.id ? ' selected' : ''}`} key={c.id}>
          <Button type="text" className="history-button" icon={<MessageOutlined />} disabled={busy} title={c.title} onClick={() => void act({ type: 'conversation:select', id: c.id })}><span className="history-title">{c.title}</span></Button>
          <Dropdown disabled={busy} trigger={['click']} menu={{ items: [
            { key: 'rename', label: '重命名', icon: <EditOutlined /> }, { key: 'delete', label: '删除', danger: true, icon: <DeleteOutlined /> }
          ], onClick: ({ key }) => key === 'rename' ? setEdit({ type: 'conversation', id: c.id, value: c.title }) : confirmDelete('conversation', c.id, c.title) }}>
            <Button type="text" size="small" className="history-menu" icon={<MoreOutlined />} disabled={busy} aria-label={`管理对话 ${c.title}`} />
          </Dropdown>
        </div>)}
      </nav>
      <div className="sidebar-bottom">
        <Button type="text" className="user-button" disabled={busy} aria-label="管理用户" onClick={() => setUsersOpen(true)}><span className="avatar">{user.name.slice(0, 1)}</span><span className="user-info"><span className="user-name">{user.name}</span><span className="user-caption">本地用户</span></span><DownOutlined /></Button>
        <Button type="text" className="settings-button" icon={<SettingOutlined />} disabled={busy} onClick={() => setSettingsOpen(true)}>设置</Button>
      </div>
    </aside>
    <main className="main">
      <header className="titlebar"><span className="titlebar-label">工作台</span><span className="titlebar-divider" /><span className="titlebar-title">{active?.title || '新对话'}</span><span className="connection"><i className={`status-dot${snapshot.config.configured ? '' : ' missing'}`} />{snapshot.config.configured ? 'DeepSeek' : '未配置密钥'}</span></header>
      <div className="workspace" ref={scroll} onScroll={() => {
        const el = scroll.current
        if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
      }}>
        {!active ? <section className="welcome"><div className="welcome-inner">
          <div className="welcome-symbol"><Mark /></div><div className="eyebrow">LET’S BUILD SOMETHING.</div>
          <h1>从一个想法开始。<span>今天想写点什么？</span></h1>
          <div className="suggestions">
            {[
              { title: '实现一个功能', icon: <CodeOutlined />, prompt: '我想实现一个新功能，请先帮我梳理需求和实现步骤。' },
              { title: '排查一个问题', icon: <BugOutlined />, prompt: '帮我排查下面的代码问题，分析原因并给出最小修复：\n\n' },
              { title: '读懂一段代码', icon: <BranchesOutlined />, prompt: '请解释下面这段代码的结构与执行流程：\n\n' }
            ].map(s => <Button className="suggestion" key={s.title} disabled={busy} onClick={() => { setDraft(s.prompt); composer.current?.focus() }}><span className="suggestion-icon">{s.icon}</span><span className="suggestion-title">{s.title}<RightOutlined className="suggestion-arrow" /></span></Button>)}
          </div>
        </div></section> : <section className="messages" aria-label="对话消息">
          {active.messages.map((m, index) => <article className="message-row" key={m.id} data-role={m.role} data-status={m.status}>
            <div className="message-label">{m.role === 'user' ? <span className="avatar">{user.name.slice(0, 1)}</span> : <span className="brand-mark"><Mark /></span>}<span>{m.role === 'user' ? user.name : 'DCode'}</span><time className="message-time">{new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div>
            {m.role === 'user' ? <div className="user-content">{m.content}</div> : renderAssistant(m, index === active.messages.length - 1)}
          </article>)}
        </section>}
      </div>
      <div className="composer-area"><div className="composer">
        <Input.TextArea ref={composer} aria-label="消息" placeholder="描述你的想法，或粘贴代码…" variant="borderless" autoSize={{ minRows: 2, maxRows: 7 }} maxLength={32_000} value={draft} disabled={busy} onChange={e => setDraft(e.target.value)} onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send() }
        }} />
        <div className="composer-tools"><span className="model-label"><ThunderboltOutlined />{modelName}</span><span className="composer-hint">{busy ? '正在生成' : 'Shift + Enter 换行'}</span>{generating ? <Button className="send-button" type="primary" icon={<StopOutlined />} loading={stopping} aria-label="停止生成" onClick={() => void stop()} /> : <Button className="send-button" type="primary" icon={<ArrowUpOutlined />} disabled={pending || !draft.trim() || !snapshot.config.configured} loading={pending} aria-label="发送消息" onClick={() => void send()} />}</div>
      </div><div className="footer-note"><span>{active ? `${active.messages.filter(m => m.role === 'user').length} 条提问` : ''}</span><span>DCode / {active?.model || modelName}</span></div></div>
    </main>
    <Modal title="设置" open={settingsOpen} onCancel={() => setSettingsOpen(false)} footer={null} width={460}>
      <div className="settings-section"><span className="settings-label">外观</span><Segmented block value={snapshot.theme} options={[{ label: '浅色', value: 'light' }, { label: '深色', value: 'dark' }]} disabled={busy} onChange={value => void act({ type: 'theme', theme: value === 'dark' ? 'dark' : 'light' })} /></div>
      <div className="settings-section"><span className="settings-label">模型服务</span><div className="settings-row"><span>服务地址</span><span className="settings-value">{snapshot.config.baseUrl}</span></div><div className="settings-row"><span>模型</span><span className="settings-value">{modelName}</span></div><div className="settings-row"><span>API 密钥</span><span>{snapshot.config.configured ? '已配置' : '未配置'}</span></div></div>
    </Modal>
    <Modal title="本地用户" open={usersOpen} onCancel={() => setUsersOpen(false)} footer={null} width={480}>
      <div className="user-list">{snapshot.users.map(u => <div className="user-list-row" key={u.id}><span className="avatar">{u.name.slice(0, 1)}</span><span className="user-list-name">{u.name}</span>{u.id === user.id ? <CheckOutlined /> : <Button size="small" disabled={busy} onClick={() => void act({ type: 'user:switch', id: u.id }).then(ok => { if (ok) setUsersOpen(false) })}>切换</Button>}<Button type="text" size="small" icon={<EditOutlined />} disabled={busy} aria-label={`编辑用户 ${u.name}`} onClick={() => setEdit({ type: 'user', id: u.id, value: u.name })} /><Button type="text" size="small" icon={<DeleteOutlined />} danger disabled={busy || snapshot.users.length === 1} aria-label={`删除用户 ${u.name}`} onClick={() => confirmDelete('user', u.id, u.name)} /></div>)}</div>
      <div className="user-create"><Input aria-label="新用户名称" placeholder="新用户名称" maxLength={40} value={newName} disabled={busy} onChange={e => setNewName(e.target.value)} /><Button type="primary" icon={<PlusOutlined />} disabled={busy || !newName.trim()} onClick={() => void act({ type: 'user:create', name: newName }).then(ok => { if (ok) { setNewName(''); setUsersOpen(false) } })}>创建</Button></div>
    </Modal>
    <Modal title={edit?.type === 'user' ? '编辑用户名称' : '重命名对话'} open={Boolean(edit)} onCancel={() => setEdit(null)} okText="保存" cancelText="取消" okButtonProps={{ disabled: busy || !edit?.value.trim() }} confirmLoading={pending} onOk={async () => {
      if (!edit) return
      const ok = await act(edit.type === 'user' ? { type: 'user:rename', id: edit.id, name: edit.value } : { type: 'conversation:rename', id: edit.id, title: edit.value })
      if (ok) setEdit(null)
    }}><Input aria-label="名称" value={edit?.value || ''} maxLength={edit?.type === 'user' ? 40 : 80} onChange={e => setEdit(previous => previous ? { ...previous, value: e.target.value } : null)} /></Modal>
  </div>
}
