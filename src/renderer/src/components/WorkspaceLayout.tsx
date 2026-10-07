import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Splitter, Tooltip } from 'antd'
import { MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons'
import type { Theme } from '../../../shared/types'

/** 工作台分栏布局；依赖 Ant Design Splitter 和 Workspace 提供的内容，独立处理拖动以避免重绘聊天消息。 */
export function WorkspaceLayout({ theme, sidebar, header, children }: {
  theme: Theme; sidebar: ReactNode; header: ReactNode; children: ReactNode
}): ReactNode {
  const [width, setWidth] = useState(() => Math.min(246, window.innerWidth / 3))
  const lastWidth = useRef(width)
  const dragStartWidth = useRef(width)
  const collapsed = width === 0

  // 窗口缩小时同步宽度上限；保留收起前宽度，展开时再按当前窗口限制。
  useEffect(() => {
    const resize = (): void => setWidth(current => Math.min(current, window.innerWidth / 3))
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  /** Splitter 连续拖动时立即更新宽度，低于 180px 收起；不调用 Workspace 或主进程。 */
  function resize(sizes: number[]): void {
    setWidth(sizes[0] < 180 ? 0 : Math.min(sizes[0], window.innerWidth / 3))
  }

  /** 拖动结束记住展开宽度；拖动收起保留手势开始前的宽度，供顶部按钮恢复。 */
  function finishResize(sizes: number[]): void {
    lastWidth.current = sizes[0] >= 180 ? sizes[0] : dragStartWidth.current || lastWidth.current
  }

  /** 顶部按钮切换侧栏，恢复上次宽度并限制在当前窗口的三分之一以内。 */
  function toggle(): void {
    if (collapsed) setWidth(Math.min(lastWidth.current, window.innerWidth / 3))
    else { lastWidth.current = width; setWidth(0) }
  }

  return <div className="shell" data-theme={theme} data-sidebar-collapsed={collapsed}>
    <Splitter collapsible={{ motion: true }} styles={{ panel: { overflow: 'hidden' } }} classNames={{ dragger: 'sidebar-dragger' }}
      onResizeStart={sizes => { dragStartWidth.current = sizes[0] }} onResize={resize} onResizeEnd={finishResize}>
      <Splitter.Panel size={width} min={0} max="33.333333%">
        <div id="workspace-sidebar" className="sidebar-content" inert={collapsed} aria-hidden={collapsed} style={{ visibility: collapsed ? 'hidden' : undefined }}>{sidebar}</div>
      </Splitter.Panel>
      <Splitter.Panel>
        <main className="main">
          <header className="titlebar">
            <Tooltip title={collapsed ? '显示侧边栏' : '隐藏侧边栏'}>
              <Button className="sidebar-toggle" type="text" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                aria-label={collapsed ? '显示侧边栏' : '隐藏侧边栏'} aria-expanded={!collapsed} aria-controls="workspace-sidebar" onClick={toggle} />
            </Tooltip>
            {header}
          </header>
          {children}
        </main>
      </Splitter.Panel>
    </Splitter>
  </div>
}
