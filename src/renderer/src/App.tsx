import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Alert, App as AntApp, Button, ConfigProvider, Dropdown, Input, Modal, Tooltip, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import {
  ArrowUpOutlined, PlusOutlined, SearchOutlined, MessageOutlined, MoreOutlined,
  SettingOutlined, CodeOutlined, BugOutlined, BranchesOutlined, CopyOutlined,
  ReloadOutlined, StopOutlined, DeleteOutlined, EditOutlined, LogoutOutlined,
  DownOutlined, RightOutlined, ThunderboltOutlined, ThunderboltFilled
} from '@ant-design/icons'
import type { Action, Message, ModelRefresh, Result, Snapshot, StreamEvent } from '../../shared/types'
import { Markdown } from './Markdown'
import { AuthScreen } from './AuthScreen'
import { ModelSettings } from './ModelSettings'

/** 绘制品牌图形，供 Workspace 的侧栏、欢迎页与 assistant 消息共用，不依赖业务类。 */
function Mark(): ReactNode {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="m8 6-5 6 5 6m8-12 5 6-5 6M14 4l-4 16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

/**
 * 界面根组件：通过 preload 的 window.dcode 读取 Snapshot，并配置 Ant Design 主题与提示容器。
 * 根据登录快照渲染 AuthScreen 或 Workspace；不直接访问主进程的 Store、Auth 或 Chat。
 */
export default function Root(): ReactNode {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState('')
  // 首次挂载时取得主进程快照；连接或读取失败时显示错误，不创建虚假的本地状态。
  useEffect(() => {
    void window.dcode.getState().then(result => {
      if (result.ok) setSnapshot(result.value)
      else setError(result.error)
    }).catch(() => setError('无法连接桌面服务，请重启应用。'))
  }, [])
  const dark = snapshot?.theme === 'dark'
  return <ConfigProvider locale={zhCN} button={{ autoInsertSpace: false }} theme={{
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: { colorPrimary: dark ? '#8ac8a3' : '#303b33', borderRadius: 8, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif' }
  }}><AntApp>
    {snapshot ? snapshot.activeUserId ? <Workspace key={snapshot.activeUserId} snapshot={snapshot} setSnapshot={setSnapshot} /> : <AuthScreen snapshot={snapshot} onLogin={setSnapshot} /> : error ? <div className="load-error"><Alert title={error} type="error" showIcon /></div> : <div className="loading">正在打开工作台…</div>}
  </AntApp></ConfigProvider>
}

/**
 * 对话工作台组件，组织会话侧栏、输入框、用户管理和设置弹窗。
 * 依赖 Root 的账号快照、Ant Design、Markdown 与 ModelSettings 组件；
 * 所有数据修改和生成操作都通过 window.dcode 间接交给主进程 Store/Chat。
 */
function Workspace({ snapshot, setSnapshot }: { snapshot: Snapshot; setSnapshot: React.Dispatch<React.SetStateAction<Snapshot | null>> }): ReactNode {
  const { message: toast, modal } = AntApp.useApp()
  const [draft, setDraft] = useState('')
  const [search, setSearch] = useState('')
  const [pending, setPending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [modelsLoading, setModelsLoading] = useState(snapshot.providers.length > 0)
  const initialRefresh = useRef<Promise<Result<ModelRefresh>> | null>(null)
  const [edit, setEdit] = useState<{ type: 'user' | 'conversation'; id: string; value: string } | null>(null)
  const streamEvents = useRef(new Map<string, StreamEvent>())
  const scroll = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const composer = useRef<React.ComponentRef<typeof Input.TextArea>>(null)
  const inFlight = useRef(false)
  const user = snapshot.users.find(u => u.id === snapshot.activeUserId)!
  const active = snapshot.conversations.find(c => c.id === snapshot.activeConversationId)
  const generating = Boolean(active?.messages.some(m => m.status === 'streaming'))
  const busy = generating || pending || stopping || modelsLoading

  /** 合并 IPC 返回的 Snapshot 与已收到的 StreamEvent，避免较早的快照覆盖较新的流式文本。 */
  const installSnapshot = useCallback((next: Snapshot): void => {
    for (const c of next.conversations) c.messages = c.messages.map(m => streamEvents.current.get(m.id)?.message || m)
    setSnapshot(next)
  }, [setSnapshot])

  // 登录后先用账号服务读取模型列表；共享同一次请求，避免 StrictMode 重复执行网络测试。
  useEffect(() => {
    if (!initialRefresh.current) initialRefresh.current = window.dcode.refreshModels()
    let active = true
    void initialRefresh.current.then(result => {
      if (!active) return
      if (result.ok) {
        installSnapshot(result.value.snapshot)
        if (result.value.errors.length) void toast.error(result.value.errors.join('\n'))
      } else void toast.error(result.error)
    }).catch(() => { if (active) void toast.error('获取模型列表失败，请重试。') }).finally(() => { if (active) setModelsLoading(false) })
    return () => { active = false }
  }, [installSnapshot, toast])

  /** 菜单主动刷新当前账号的模型列表，更新成功服务并显示失败原因，保留原聊天和草稿。 */
  async function refreshModels(): Promise<void> {
    if (busy || inFlight.current) return
    inFlight.current = true; setModelsLoading(true)
    try {
      const result = await window.dcode.refreshModels()
      if (result.ok) {
        installSnapshot(result.value.snapshot)
        if (result.value.errors.length) void toast.error(result.value.errors.join('\n'))
      } else void toast.error(result.error)
    } catch { void toast.error('获取模型列表失败，请重试。') }
    finally { inFlight.current = false; setModelsLoading(false) }
  }

  // 按会话/消息 ID 更新流式回复；effect 返回 preload 提供的退订函数，防止重复监听。
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

  // 用户仍停留在底部时跟随新消息滚动；向上阅读历史后不强制拉回底部。
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [active?.messages, active?.id])

  /**
   * 通过 window.dcode.action 执行用户/会话/主题操作，并用 installSnapshot 同步界面。
   * inFlight 防止重复提交；切换上下文时清空草稿，返回成功标志供弹窗决定是否关闭。
   */
  const act = useCallback(async (action: Action): Promise<boolean> => {
    if (inFlight.current) return false
    inFlight.current = true
    setPending(true)
    try {
      const result = await window.dcode.action(action)
      if (!result.ok) { void toast.error(result.error); return false }
      streamEvents.current.clear()
      installSnapshot(result.value)
      if (['conversation:select', 'conversation:delete'].includes(action.type)) {
        setDraft(''); follow.current = true
      }
      return true
    } catch { void toast.error('操作失败，请重试。'); return false }
    finally { inFlight.current = false; setPending(false) }
  }, [installSnapshot, toast])

  useEffect(() => {
    /** 处理 Cmd/Ctrl+N：生成结束后通过 act 切换到新对话，并聚焦输入框。 */
    const handler = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        if (!busy) void act({ type: 'conversation:select', id: null }).then(() => composer.current?.focus())
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [act, busy])

  /**
   * 发送草稿或重新生成最后一条回复，依赖 window.dcode.send 调用主进程 Chat。
   * 通过 installSnapshot 合并初始消息与流事件；发送成功才清空草稿，失败则保留输入。
   */
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

  /** 请求 window.dcode.stop 等待 Chat 取消并保存，再用 installSnapshot 显示最终回复状态。 */
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

  /** 主动撤销保持登录的令牌并通知 Root 显示登录页，聊天与模型配置留在账号下。 */
  async function logout(): Promise<void> {
    if (busy || inFlight.current) return
    inFlight.current = true; setPending(true)
    try {
      const result = await window.dcode.logout()
      if (result.ok) setSnapshot(result.value)
      else void toast.error(result.error)
    } catch { void toast.error('退出失败，请重试。') }
    finally { inFlight.current = false; setPending(false) }
  }

  /** 使用 Ant Design modal 确认删除会话，再交给 act 与主进程 Store 检查账号归属。 */
  function confirmDelete(id: string, name: string): void {
    modal.confirm({
      title: '删除这段对话？', content: name,
      okText: '删除', cancelText: '取消', okButtonProps: { danger: true },
      onOk: async () => { if (!await act({ type: 'conversation:delete', id })) throw new Error('删除失败') }
    })
  }

  /**
   * 将 assistant 的 Message 渲染为 Markdown、推理内容、生成状态及复制/重试操作。
   * 依赖 Markdown 组件与 Ant Design；复制走 window.dcode.copyText，最后一条回复可调用 send 重试。
   */
  function renderAssistant(m: Message, last: boolean): ReactNode {
    return <div className="assistant-content">
      {m.reasoning && <details className="reasoning"><summary>思考过程</summary><p>{m.reasoning}</p></details>}
      {m.content ? <Markdown content={m.content} /> : m.status === 'streaming' ? <div className="thinking-dots" aria-label="正在生成"><i /><i /><i /></div> : null}
      {m.status === 'error' && <Alert title={m.error || '生成失败，请重试。'} type="error" showIcon />}
      {m.status === 'stopped' && <div className="message-status">已停止生成</div>}
      {m.status !== 'streaming' && <div className="message-actions">
        {m.content && <Button type="text" size="small" icon={<CopyOutlined />} aria-label="复制回复" onClick={() => {
          void window.dcode.copyText(m.content).then(result => result.ok ? toast.success('已复制') : toast.error(result.error)).catch(() => toast.error('复制失败。'))
        }} />}
        {last && <Button type="text" size="small" icon={<ReloadOutlined />} aria-label="重新生成" disabled={busy} onClick={() => void send(true)}>重新生成</Button>}
      </div>}
    </div>
  }

  const conversations = snapshot.conversations.filter(c => `${c.title} ${c.messages.map(m => m.content).join(' ')}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const modelName = snapshot.config.model
  const modelChoices = snapshot.providers.flatMap(provider => provider.availableModels.map(model => ({ key: JSON.stringify([provider.id, model]), providerId: provider.id, model })))
  return <div className="shell" data-theme={snapshot.theme}>
    <aside className="sidebar">
      <div className="window-space" />
      <div className="brand"><span className="brand-mark"><Mark /></span><span className="brand-name">DCode</span><span className="brand-version">0.1</span></div>
      <Button className="new-chat" icon={<PlusOutlined />} aria-label="新对话" disabled={busy} onClick={() => void act({ type: 'conversation:select', id: null }).then(() => composer.current?.focus())}>新对话 <kbd className="shortcut">⌘ N</kbd></Button>
      <Input className="search" prefix={<SearchOutlined />} placeholder="搜索对话" aria-label="搜索对话" variant="borderless" allowClear value={search} onChange={e => setSearch(e.target.value)} />
      <div className="section-label"><span>最近对话</span><span>{snapshot.conversations.length ? snapshot.conversations.length : ''}</span></div>
      <nav className="history" aria-label="会话列表">
        {!conversations.length && <div className="history-empty">{search ? '没有找到对话' : '暂无对话'}</div>}
        {conversations.map(c => <div className={`history-item${c.id === active?.id ? ' selected' : ''}`} key={c.id}>
          <Button type="text" className="history-button" icon={<MessageOutlined />} aria-label={c.title} disabled={busy} title={c.title} onClick={() => void act({ type: 'conversation:select', id: c.id })}><span className="history-title">{c.title}</span></Button>
          <Dropdown disabled={busy} trigger={['click']} menu={{ items: [
            { key: 'rename', label: '重命名', icon: <EditOutlined /> }, { key: 'delete', label: '删除', danger: true, icon: <DeleteOutlined /> }
          ], onClick: ({ key }) => key === 'rename' ? setEdit({ type: 'conversation', id: c.id, value: c.title }) : confirmDelete(c.id, c.title) }}>
            <Button type="text" size="small" className="history-menu" icon={<MoreOutlined />} disabled={busy} aria-label={`管理对话 ${c.title}`} />
          </Dropdown>
        </div>)}
      </nav>
      <div className="sidebar-bottom">
        <Dropdown disabled={busy} trigger={['click']} menu={{ items: [
          { key: 'rename', label: '编辑名称', icon: <EditOutlined /> },
          { key: 'logout', label: '退出登录', icon: <LogoutOutlined /> }
        ], onClick: ({ key }) => key === 'logout' ? void logout() : setEdit({ type: 'user', id: user.id, value: user.name }) }}>
          <Button type="text" className="user-button" disabled={busy} aria-label="账号菜单"><span className="avatar">{user.name.slice(0, 1)}</span><span className="user-info"><span className="user-name">{user.name}</span><span className="user-caption">{user.username}</span></span><DownOutlined /></Button>
        </Dropdown>
        <Button type="text" className="settings-button" icon={<SettingOutlined />} aria-label="设置" disabled={busy} onClick={() => setSettingsOpen(true)}>设置</Button>
      </div>
    </aside>
    <main className="main">
      <header className="titlebar"><span className="titlebar-label">工作台</span><span className="titlebar-divider" /><span className="titlebar-title">{active?.title || '新对话'}</span><span className="connection"><i className={`status-dot${snapshot.config.configured ? '' : ' missing'}`} />{snapshot.config.configured ? new URL(snapshot.config.baseUrl).hostname : '未配置模型'}</span></header>
      <div className="workspace" ref={scroll} onScroll={() => {
        const el = scroll.current
        if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
      }}>
        {!active ? <section className="welcome"><div className="welcome-inner">
          <div className="welcome-symbol"><Mark /></div>
          <h1>今天想写点什么？</h1>
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
        <div className="composer-tools"><Tooltip title={`${snapshot.fastMode ? '关闭' : '开启'}快速模式 · 仅对支持加速的模型生效`}><Button className="speed-button" style={snapshot.fastMode ? { color: '#1677ff' } : undefined} type="text" disabled={busy} icon={snapshot.fastMode ? <ThunderboltFilled /> : <ThunderboltOutlined />} aria-label="快速模式" aria-pressed={snapshot.fastMode} onClick={() => void act({ type: 'fast-mode', enabled: !snapshot.fastMode })} /></Tooltip>
          <Dropdown disabled={busy} trigger={['click']} menu={{ style: { maxHeight: 360, overflowY: 'auto' }, selectedKeys: snapshot.selectedModel ? [JSON.stringify([snapshot.activeProviderId, snapshot.selectedModel])] : [], items: [
            ...snapshot.providers.map(provider => ({ key: provider.id, type: 'group' as const, label: provider.name, children: modelChoices.filter(choice => choice.providerId === provider.id).map(choice => ({ key: choice.key, label: choice.model })) })),
            { key: 'refresh', label: '刷新模型列表', icon: <ReloadOutlined />, disabled: !snapshot.providers.length },
            { key: 'settings', label: '配置模型服务', icon: <SettingOutlined /> }
          ], onClick: ({ key }) => {
            if (key === 'settings') setSettingsOpen(true)
            else if (key === 'refresh') void refreshModels()
            else {
              const choice = modelChoices.find(item => item.key === key)
              if (choice) void act({ type: 'model:select', providerId: choice.providerId, model: choice.model })
            }
          } }}>
            <Button className="model-selector" type="text" aria-label="切换模型" disabled={busy} loading={modelsLoading}><span className="model-selector-label">{modelName || '选择模型'}</span><DownOutlined /></Button>
          </Dropdown><span className="composer-hint">{busy ? '正在生成' : 'Shift + Enter 换行'}</span>{generating ? <Button className="send-button" type="primary" icon={<StopOutlined />} loading={stopping} aria-label="停止生成" onClick={() => void stop()} /> : <Button className="send-button" type="primary" icon={<ArrowUpOutlined />} disabled={pending || !draft.trim() || !snapshot.config.configured} loading={pending} aria-label="发送消息" onClick={() => void send()} />}</div>
      </div><div className="footer-note"><span>{active ? `${active.messages.filter(m => m.role === 'user').length} 条提问` : ''}</span><span>DCode / {active?.model || modelName}</span></div></div>
    </main>
    {settingsOpen && <ModelSettings snapshot={snapshot} busy={busy} onClose={() => setSettingsOpen(false)} onSaved={installSnapshot} onTheme={value => void act({ type: 'theme', theme: value })} />}
    <Modal title={edit?.type === 'user' ? '编辑用户名称' : '重命名对话'} open={Boolean(edit)} onCancel={() => setEdit(null)} okText="保存" cancelText="取消" okButtonProps={{ disabled: busy || !edit?.value.trim() }} confirmLoading={pending} onOk={async () => {
      if (!edit) return
      const ok = await act(edit.type === 'user' ? { type: 'user:rename', id: edit.id, name: edit.value } : { type: 'conversation:rename', id: edit.id, title: edit.value })
      if (ok) setEdit(null)
    }}><Input aria-label="名称" value={edit?.value || ''} maxLength={edit?.type === 'user' ? 40 : 80} onChange={e => setEdit(previous => previous ? { ...previous, value: e.target.value } : null)} /></Modal>
  </div>
}
