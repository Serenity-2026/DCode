import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { Alert, App as AntApp, Button, Dropdown, Input, Modal } from 'antd'
import {
  ArrowUpOutlined, PlusOutlined, SearchOutlined, MessageOutlined, MoreOutlined,
  SettingOutlined, CodeOutlined, BugOutlined, BranchesOutlined, CopyOutlined,
  ReloadOutlined, StopOutlined, DeleteOutlined, EditOutlined, LogoutOutlined,
  DownOutlined, RightOutlined, LoadingOutlined, FormOutlined
} from '@ant-design/icons'
import type { Action, Attachment, Message, ModelRefresh, Result, Snapshot, StreamEvent } from '../../../../shared/types'
import { estimateContext, validateAttachments } from '../../../../shared/context'
import { AssistantTimeline } from './components/AssistantTimeline'
import { FilePreviewPanel } from './components/FilePreviewPanel'
import { ModelSettings } from '../settings/ModelSettings'
import { ComposerTools } from './components/ComposerTools'
import { AttachmentList } from './components/AttachmentList'
import { WorkspaceLayout } from '../../components/WorkspaceLayout'
import { MessageNavigation } from './components/MessageNavigation'
import { BrandMark } from '../../components/BrandMark'
import { WelcomeCloud } from './components/WelcomeCloud'
import { ProjectDialog } from './components/ProjectDialog'

/**
 * 对话工作台组件，组织会话侧栏、输入框、用户管理和设置弹窗。
 * 依赖 Root 的账号快照、Ant Design、Markdown 与 ModelSettings 组件；
 * 所有数据修改和生成操作都通过 window.dcode 间接交给主进程 StateService/AgentSession。
 */
export function Workspace({ snapshot, setSnapshot }: { snapshot: Snapshot; setSnapshot: React.Dispatch<React.SetStateAction<Snapshot | null>> }): ReactNode {
  const { message: toast, modal } = AntApp.useApp()
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [search, setSearch] = useState('')
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [projectOpen, setProjectOpen] = useState(false)
  const [previewSelection, setPreviewSelection] = useState<{ messageId: string; toolId: string } | null>(null)
  const [modelsLoading, setModelsLoading] = useState(snapshot.providers.length > 0)
  const initialRefresh = useRef<Promise<Result<ModelRefresh>> | null>(null)
  const [edit, setEdit] = useState<{ type: 'user' | 'conversation'; id: string; value: string } | null>(null)
  const streamEvents = useRef(new Map<string, StreamEvent>())
  const scroll = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const jumping = useRef(false)
  const composer = useRef<React.ComponentRef<typeof Input.TextArea>>(null)
  const inFlight = useRef(false)
  const user = snapshot.users.find(u => u.id === snapshot.activeUserId)!
  const active = snapshot.conversations.find(c => c.id === snapshot.activeConversationId)
  const previewTool = active?.messages.find(message => message.id === previewSelection?.messageId)?.toolExecutions?.find(tool => tool.id === previewSelection?.toolId)
  const folderName = active?.directory.split(/[\\/]/).filter(Boolean).at(-1) || active?.directory
  const generating = Boolean(active?.messages.some(m => m.status === 'streaming'))
  const interacting = pending || stopping || modelsLoading || projectOpen
  const busy = generating || interacting

  /** 合并 IPC 返回的 Snapshot 与已收到的 StreamEvent，避免较早的快照覆盖较新的流式文本。 */
  const installSnapshot = useCallback((next: Snapshot): void => {
    for (const c of next.conversations) c.messages = c.messages.map(m => streamEvents.current.get(m.id)?.message || m)
    setSnapshot(next)
  }, [setSnapshot])

  /** 新建项目和新建对话共用进入动作，展开目标分组并清空原草稿。 */
  const enterConversation = useCallback((next: Snapshot): void => {
    installSnapshot(next)
    const directory = next.conversations.find(c => c.id === next.activeConversationId)!.directory
    setCollapsedFolders(previous => { const expanded = new Set(previous); expanded.delete(directory); return expanded })
    setDraft(''); setAttachments([]); setSearch(''); setPreviewSelection(null)
    follow.current = true; jumping.current = false
  }, [installSnapshot])

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

  /** 生成期间更新输入区域圆环的位置；依赖局部容器和 CSS 动画，不触发 Workspace 重渲染。 */
  function moveGenerationCursor(event: PointerEvent<HTMLDivElement>): void {
    if (!generating) return
    const rect = event.currentTarget.getBoundingClientRect()
    event.currentTarget.style.setProperty('--cursor-x', `${event.clientX - rect.left}px`)
    event.currentTarget.style.setProperty('--cursor-y', `${event.clientY - rect.top}px`)
  }

  /** 导航到指定问题；依赖消息 DOM 锚点，平滑跳转期间暂停跟随流式输出，减少动画时即时滚动。 */
  function navigateMessage(id: string): void {
    const container = scroll.current
    const message = document.getElementById(`message-${id}`)
    if (!container || !message || !container.contains(message)) return
    const top = Math.max(0, message.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 24)
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    jumping.current = smooth && Math.abs(container.scrollTop - top) > 1
    follow.current = false
    container.scrollTo({ top, behavior: smooth ? 'smooth' : 'instant' })
  }

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
      installSnapshot(result.value)
      if (['conversation:select', 'conversation:delete'].includes(action.type) || action.type === 'folder:delete' && result.value.activeConversationId !== snapshot.activeConversationId) {
        setDraft(''); setAttachments([]); follow.current = true; jumping.current = false
        setPreviewSelection(null)
      }
      return true
    } catch { void toast.error('操作失败，请重试。'); return false }
    finally { inFlight.current = false; setPending(false) }
  }, [installSnapshot, toast, snapshot.activeConversationId])

  /** 新建时选择目录，文件夹菜单则复用已有会话目录；后台任务继续运行。 */
  const createConversation = useCallback(async (sourceId?: string): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true; setPending(true)
    try {
      const result = await window.dcode.createConversation(sourceId)
      if (!result.ok) { void toast.error(result.error); return }
      if (result.value === null) return
      enterConversation(result.value)
    } catch { void toast.error('新建对话失败，请重试。') }
    finally { inFlight.current = false; setPending(false); composer.current?.focus() }
  }, [enterConversation, toast])

  /** 打开 preload 选择器并校验附件快照，附件不改变会话工作目录。 */
  async function addAttachments(kind: 'file' | 'folder'): Promise<void> {
    if (busy || inFlight.current) return
    inFlight.current = true; setPending(true)
    try {
      const result = await window.dcode.selectAttachments(kind)
      if (!result.ok) { void toast.error(result.error); return }
      const previous = kind === 'folder' && result.value.attachments.length ? attachments.filter(item => item.kind !== 'folder') : attachments
      const next = validateAttachments([...previous, ...result.value.attachments])
      setAttachments(next)
      if (result.value.skipped) void toast.warning(`已跳过 ${result.value.skipped} 项非文本、隐藏或忽略项。`)
    } catch (error) { void toast.error(error instanceof Error ? error.message : '添加附件失败，请重试。') }
    finally { inFlight.current = false; setPending(false); composer.current?.focus() }
  }

  useEffect(() => {
    /** 处理 Cmd/Ctrl+N：后台任务继续执行，导航到新对话并聚焦输入框。 */
    const handler = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        if (!interacting) void createConversation()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [createConversation, interacting])

  /**
   * 发送草稿或重新生成最后一条回复，依赖 window.dcode.send 调用主进程 AgentSession。
   * 通过 installSnapshot 合并初始消息与流事件；发送成功才清空草稿，失败则保留输入。
   */
  async function send(retry = false): Promise<void> {
    if (busy || inFlight.current || (!retry && !draft.trim() && !attachments.length)) return
    inFlight.current = true
    setPending(true)
    follow.current = true
    jumping.current = false
    try {
      let conversationId = active?.id
      if (!conversationId) {
        const created = await window.dcode.createConversation()
        if (!created.ok) { void toast.error(created.error); return }
        if (created.value === null) return
        installSnapshot(created.value)
        conversationId = created.value.activeConversationId!
      }
      const result = await window.dcode.send({ content: draft.trim(), retry, conversationId, ...(retry ? {} : { attachments }) })
      if (result.ok) { installSnapshot(result.value); if (!retry) { setDraft(''); setAttachments([]) } }
      else void toast.error(result.error)
    } catch { void toast.error('发送失败，请重试。') }
    finally { inFlight.current = false; setPending(false); composer.current?.focus() }
  }

  /** 请求 window.dcode.stop 等待 AgentSession 取消并保存，再用 installSnapshot 显示最终回复状态。 */
  async function stop(): Promise<void> {
    if (stopping || !active) return
    setStopping(true)
    try {
      const result = await window.dcode.stop(active.id)
      if (result.ok) installSnapshot(result.value)
      else void toast.error(result.error)
    } catch { void toast.error('停止失败，请重试。') }
    finally { setStopping(false) }
  }

  /** 主动撤销保持登录的令牌并通知 Root 显示登录页，聊天与模型配置留在账号下。 */
  async function logout(): Promise<void> {
    if (interacting || inFlight.current) return
    inFlight.current = true; setPending(true)
    try {
      const result = await window.dcode.logout()
      if (result.ok) setSnapshot(result.value)
      else void toast.error(result.error)
    } catch { void toast.error('退出失败，请重试。') }
    finally { inFlight.current = false; setPending(false) }
  }

  /** 使用 Ant Design modal 确认删除会话，再交给 act 与主进程 StateService 检查账号归属。 */
  function confirmDelete(id: string, name: string): void {
    modal.confirm({
      title: '删除这段对话？', content: name,
      okText: '删除', cancelText: '取消', okButtonProps: { danger: true },
      onOk: async () => { if (!await act({ type: 'conversation:delete', id })) throw new Error('删除失败') }
    })
  }

  /** 删除应用内分组和其全部会话，确认时说明范围；磁盘文件不参与删除。 */
  function confirmDeleteFolder(id: string, name: string, count: number): void {
    modal.confirm({
      title: '删除此文件夹？', content: `将删除“${name}”及其 ${count} 段对话，保留磁盘文件。`,
      okText: '删除', cancelText: '取消', okButtonProps: { danger: true },
      onOk: async () => { if (!await act({ type: 'folder:delete', id })) throw new Error('删除失败') }
    })
  }

  /**
   * 将 assistant 的 Message 渲染为 Markdown、推理内容、生成状态及复制/重试操作。
   * 依赖 Markdown 组件与 Ant Design；复制走 window.dcode.copyText，最后一条回复可调用 send 重试。
   */
  function renderAssistant(m: Message, last: boolean): ReactNode {
    const tools = m.toolExecutions || []
    const running = tools.some(tool => tool.status === 'running')
    return <div className="assistant-content">
      {m.reasoning && <details className="reasoning"><summary>思考过程</summary><p>{m.reasoning}</p></details>}
      <AssistantTimeline message={m} selectedToolId={previewSelection?.messageId === m.id ? previewSelection.toolId : undefined}
        onPreview={tool => setPreviewSelection({ messageId: m.id, toolId: tool.id })} />
      {!m.content && m.status === 'streaming' && !running && <div className="thinking-dots" aria-label="正在生成"><i /><i /><i /></div>}
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

  const conversations = snapshot.conversations.filter(c => `${c.directory} ${c.title} ${c.messages.map(m => m.content).join(' ')}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const folders = [...new Set(conversations.map(c => c.directory))].map(directory => {
    const all = snapshot.conversations.filter(c => c.directory === directory)
    return { directory, name: directory.split(/[\\/]/).filter(Boolean).at(-1) || directory, conversations: conversations.filter(c => c.directory === directory), count: all.length, running: all.some(c => c.messages.some(m => m.status === 'streaming')) }
  })
  const projectsCollapsed = !snapshot.conversations.length || snapshot.conversations.every(c => collapsedFolders.has(c.directory))
  const modelName = snapshot.config.model
  const usedTokens = estimateContext(active, draft, attachments, generating)
  return <>
    <WorkspaceLayout theme={snapshot.theme} preview={previewTool && <FilePreviewPanel key={`${previewSelection!.messageId}:${previewTool.id}`} tool={previewTool} onClose={() => setPreviewSelection(null)} />} sidebar={
    <aside className="sidebar">
      <div className="window-space" />
      <div className="brand"><span className="brand-mark"><BrandMark /></span><span className="brand-name">DCode</span><span className="brand-version">0.1</span></div>
      <Button className="new-chat" icon={<PlusOutlined />} aria-label="新对话" disabled={interacting} onClick={() => void createConversation()}>新对话 <kbd className="shortcut">⌘ N</kbd></Button>
      <Input className="search" prefix={<SearchOutlined />} placeholder="搜索对话" aria-label="搜索对话" variant="borderless" allowClear value={search} onChange={e => { setSearch(e.target.value); if (e.target.value) setCollapsedFolders(new Set()) }} />
      <div className="project-section">
        <Button className="project-toggle" type="text" disabled={interacting || !snapshot.conversations.length} aria-label="项目" aria-expanded={!projectsCollapsed} title={projectsCollapsed ? '展开全部项目' : '收起全部项目'} onClick={() => setCollapsedFolders(new Set(projectsCollapsed ? [] : snapshot.conversations.map(c => c.directory)))}>项目</Button>
        <Button className="project-add" type="text" icon={<PlusOutlined />} disabled={interacting} aria-label="添加项目" onClick={() => setProjectOpen(true)} />
      </div>
      <nav className="history" aria-label="会话列表">
        {!conversations.length && <div className="history-empty">{search ? '没有找到对话' : '暂无对话'}</div>}
        {folders.map(folder => <section className="folder-group" key={folder.directory} data-directory={folder.directory}>
          <Dropdown disabled={interacting} trigger={['contextMenu']} menu={{ items: [
            { key: 'new', label: '在此文件夹下新建对话', icon: <PlusOutlined /> },
            { key: 'delete', label: '删除文件夹', icon: <DeleteOutlined />, danger: true, disabled: folder.running }
          ], onClick: ({ key }) => key === 'new' ? void createConversation(folder.conversations[0].id) : confirmDeleteFolder(folder.conversations[0].id, folder.name, folder.count) }}>
            <div className="folder-row">
            <Button className="folder-header" type="text" disabled={interacting} title={folder.directory} aria-label={`文件夹 ${folder.directory}`} aria-expanded={!collapsedFolders.has(folder.directory)} onClick={() => setCollapsedFolders(previous => {
              const next = new Set(previous)
              if (next.has(folder.directory)) next.delete(folder.directory)
              else next.add(folder.directory)
              return next
            })}>
              <svg className="folder-icon" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                <path d={collapsedFolders.has(folder.directory)
                  ? 'M2 9h20M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2Z'
                  : 'M2 17V6a2 2 0 0 1 2-2h5l2 2h8a2 2 0 0 1 2 2v2M2 20h16l4-10H6L2 20Z'} />
              </svg><span className="folder-name">{folder.name}</span>
            </Button>
            <Button className="folder-new-chat" type="text" icon={<FormOutlined />} disabled={interacting} aria-label={`在 ${folder.name} 中新建对话`} title="新建对话" onClick={() => void createConversation(folder.conversations[0].id)} />
            </div>
          </Dropdown>
          <div className="folder-motion" data-expanded={!collapsedFolders.has(folder.directory)} aria-hidden={collapsedFolders.has(folder.directory)} inert={collapsedFolders.has(folder.directory)}>
          <div className="folder-conversations">{folder.conversations.map((c, index) => <div className={`history-item${c.id === active?.id ? ' selected' : ''}`} key={c.id} style={{ transitionDelay: !collapsedFolders.has(folder.directory) ? `${Math.min(index, 6) * 25}ms` : '0ms' }}>
          <Button type="text" className="history-button" icon={c.messages.some(m => m.status === 'streaming') ? <LoadingOutlined spin /> : <MessageOutlined />} aria-label={c.title} disabled={interacting} title={c.title} onClick={() => void act({ type: 'conversation:select', id: c.id })}><span className="history-title">{c.title}</span></Button>
          <Dropdown disabled={interacting} trigger={['click']} menu={{ items: [
            { key: 'rename', label: '重命名', icon: <EditOutlined /> }, { key: 'delete', label: '删除', danger: true, disabled: c.messages.some(m => m.status === 'streaming'), icon: <DeleteOutlined /> }
          ], onClick: ({ key }) => key === 'rename' ? setEdit({ type: 'conversation', id: c.id, value: c.title }) : confirmDelete(c.id, c.title) }}>
            <Button type="text" size="small" className="history-menu" icon={<MoreOutlined />} disabled={interacting} aria-label={`管理对话 ${c.title}`} />
          </Dropdown>
        </div>)}</div></div>
        </section>)}
      </nav>
      <div className="sidebar-bottom">
        <Dropdown disabled={interacting} trigger={['click']} menu={{ items: [
          { key: 'rename', label: '编辑名称', icon: <EditOutlined /> },
          { key: 'logout', label: '退出登录', icon: <LogoutOutlined /> }
        ], onClick: ({ key }) => key === 'logout' ? void logout() : setEdit({ type: 'user', id: user.id, value: user.name }) }}>
          <Button type="text" className="user-button" disabled={interacting} aria-label="账号菜单"><span className="avatar">{user.name.slice(0, 1)}</span><span className="user-info"><span className="user-name">{user.name}</span><span className="user-caption">{user.username}</span></span><DownOutlined /></Button>
        </Dropdown>
        <Button type="text" className="settings-button" icon={<SettingOutlined />} aria-label="设置" disabled={busy} onClick={() => setSettingsOpen(true)}>设置</Button>
      </div>
    </aside>} header={<><span className="titlebar-label">工作台</span><span className="titlebar-divider" /><span className="titlebar-title">{active?.title || '新对话'}</span><span className="connection"><i className={`status-dot${snapshot.config.configured ? '' : ' missing'}`} />{snapshot.config.configured ? new URL(snapshot.config.baseUrl).hostname : '未配置模型'}</span></>}>
      <div className="conversation-body">
      <div className="workspace" ref={scroll} onWheel={() => { jumping.current = false }} onPointerDown={() => { jumping.current = false }} onScrollEnd={() => {
        jumping.current = false
        const el = scroll.current
        if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
      }} onScroll={() => {
        const el = scroll.current
        if (el) follow.current = !jumping.current && el.scrollHeight - el.scrollTop - el.clientHeight < 100
      }}>
        {!active?.messages.length ? <section className="welcome"><div className="welcome-inner">
          <WelcomeCloud />
          <h1>{folderName ? <>今天想在 <span className="welcome-folder" title={active?.directory}>{folderName}</span> 中写点什么？</> : '今天想写点什么？'}</h1>
          <div className="suggestions">
            {[
              { title: '实现一个功能', icon: <CodeOutlined />, prompt: '我想实现一个新功能，请先帮我梳理需求和实现步骤。' },
              { title: '排查一个问题', icon: <BugOutlined />, prompt: '帮我排查下面的代码问题，分析原因并给出最小修复：\n\n' },
              { title: '读懂一段代码', icon: <BranchesOutlined />, prompt: '请解释下面这段代码的结构与执行流程：\n\n' }
            ].map(s => <Button className="suggestion" key={s.title} disabled={busy} onClick={() => { setDraft(s.prompt); composer.current?.focus() }}><span className="suggestion-icon">{s.icon}</span><span className="suggestion-title">{s.title}<RightOutlined className="suggestion-arrow" /></span></Button>)}
          </div>
        </div></section> : <section className="messages" aria-label="对话消息">
          {active.messages.map((m, index) => <article className="message-row" id={`message-${m.id}`} key={m.id} data-role={m.role} data-status={m.status}>
            <div className="message-label">{m.role === 'user' ? <span className="avatar">{user.name.slice(0, 1)}</span> : <span className="brand-mark"><BrandMark /></span>}<span>{m.role === 'user' ? user.name : 'DCode'}</span><time className="message-time">{new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div>
            {m.role === 'user' ? <><div className="user-content">{m.content}</div>{Boolean(m.attachments?.length) && <div className="message-attachments"><AttachmentList items={m.attachments!} /></div>}</> : renderAssistant(m, index === active.messages.length - 1)}
          </article>)}
        </section>}
      </div>
      {active && <MessageNavigation key={active.id} messages={active.messages} theme={snapshot.theme} containerRef={scroll} onNavigate={navigateMessage} />}
      </div>
      <div className="composer-area"><div className="composer">
        {Boolean(attachments.length) && <AttachmentList items={attachments} disabled={busy} onRemove={id => setAttachments(previous => previous.filter(item => item.id !== id))} />}
        <div className="composer-input" data-generating={generating} onPointerMove={moveGenerationCursor}>
        <Input.TextArea ref={composer} aria-label="消息" placeholder="描述你的想法，或粘贴代码…" variant="borderless" autoSize={{ minRows: 2, maxRows: 7 }} maxLength={32_000} value={draft} disabled={busy} onChange={e => setDraft(e.target.value)} onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send() }
        }} />
        {generating && <span className="generation-cursor" aria-hidden="true" />}
        </div>
        <ComposerTools snapshot={snapshot} busy={busy} modelsLoading={modelsLoading} usedTokens={usedTokens} onAdd={kind => void addAttachments(kind)} onModel={(providerId, model) => void act({ type: 'model:select', providerId, model })} onRefresh={() => void refreshModels()} onSettings={() => setSettingsOpen(true)} onFastMode={() => void act({ type: 'fast-mode', enabled: !snapshot.fastMode })} onEffort={effort => act({ type: 'reasoning-effort', effort })} sendButton={generating ? <Button className="send-button" type="primary" icon={<StopOutlined />} loading={stopping} aria-label="停止生成" onClick={() => void stop()} /> : <Button className="send-button" type="primary" icon={<ArrowUpOutlined />} disabled={busy || (!draft.trim() && !attachments.length) || !snapshot.config.configured} loading={pending} aria-label="发送消息" onClick={() => void send()} />} />
      </div><div className="footer-note"><span>{active ? `${active.messages.filter(m => m.role === 'user').length} 条提问` : 'Shift + Enter 换行'}</span><span>DCode / {active?.model || modelName}</span></div></div>
    </WorkspaceLayout>
    {settingsOpen && <ModelSettings snapshot={snapshot} busy={busy} onClose={() => setSettingsOpen(false)} onSaved={installSnapshot} onTheme={value => void act({ type: 'theme', theme: value })} />}
    {projectOpen && <ProjectDialog onClose={() => setProjectOpen(false)} onCreated={next => { enterConversation(next); setProjectOpen(false) }} />}
    <Modal title={edit?.type === 'user' ? '编辑用户名称' : '重命名对话'} open={Boolean(edit)} onCancel={() => setEdit(null)} okText="保存" cancelText="取消" okButtonProps={{ disabled: busy || !edit?.value.trim() }} confirmLoading={pending} onOk={async () => {
      if (!edit) return
      const ok = await act(edit.type === 'user' ? { type: 'user:rename', id: edit.id, name: edit.value } : { type: 'conversation:rename', id: edit.id, title: edit.value })
      if (ok) setEdit(null)
    }}><Input aria-label="名称" value={edit?.value || ''} maxLength={edit?.type === 'user' ? 40 : 80} onChange={e => setEdit(previous => previous ? { ...previous, value: e.target.value } : null)} /></Modal>
  </>
}
