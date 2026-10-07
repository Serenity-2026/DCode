import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Button, Popover } from 'antd'
import { FileOutlined } from '@ant-design/icons'
import type { Message, Theme } from '../../../../../shared/types'
import { Markdown } from './Markdown'

/** 对话左侧短线导航；依赖 Workspace 的滚动容器与消息、Ant Design 浮层和 Markdown，独立同步阅读位置。 */
export function MessageNavigation({ messages, theme, containerRef, onNavigate }: {
  messages: Message[]; theme: Theme; containerRef: RefObject<HTMLDivElement | null>; onNavigate: (id: string) => void
}): ReactNode {
  const turns = messages.flatMap((message, index) => message.role === 'user' ? [{
    question: message, answer: messages[index + 1]?.role === 'assistant' ? messages[index + 1] : undefined
  }] : [])
  const questionIds = turns.map(turn => turn.question.id)
  const idsKey = JSON.stringify(questionIds)
  const [currentId, setCurrentId] = useState(questionIds.at(-1))
  const [previewId, setPreviewId] = useState<string | null>(null)
  const navigation = useRef<HTMLElement>(null)
  const currentIndex = Math.max(0, questionIds.indexOf(currentId || ''))
  const motion = useRef({ position: currentIndex, target: currentIndex, frame: 0, pointerY: null as number | null, focusIndex: null as number | null })

  /** 依赖导航短线 DOM，以帧间时间平滑追踪峰值；只更新缩放和透明度，不重排布局或重绘 Markdown。 */
  function animatePeak(target: number): void {
    const state = motion.current
    state.target = target
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) { cancelAnimationFrame(state.frame); state.frame = 0; state.position = target }
    if (state.frame) return
    let previous = performance.now()

    /** 每帧绘制一个对称峰形；连续鼠标移动只更新目标，沿用正在运行的动画。 */
    function draw(now: number): void {
      const elapsed = Math.min(64, now - previous)
      previous = now
      state.position += (state.target - state.position) * (1 - Math.exp(-elapsed / 55))
      const settled = Math.abs(state.target - state.position) < 0.001
      if (settled) state.position = state.target
      navigation.current?.querySelectorAll<HTMLElement>('.message-navigation-line').forEach((line, index) => {
        const weight = Math.exp(-Math.pow(index - state.position, 2) / 3)
        line.style.transform = `scaleX(${0.25 + 0.75 * weight})`
        line.style.opacity = String(0.3 + 0.7 * weight)
      })
      state.frame = settled ? 0 : requestAnimationFrame(draw)
    }

    if (reduced) draw(previous)
    else state.frame = requestAnimationFrame(draw)
  }

  /** 依赖等高的导航按钮，将鼠标纵坐标转换为连续峰值；离开后恢复键盘焦点或阅读轮次。 */
  function syncPeak(): void {
    const state = motion.current
    const first = navigation.current?.querySelector<HTMLElement>('.message-navigation-entry')
    if (state.pointerY !== null && first) {
      const rect = first.getBoundingClientRect()
      animatePeak(Math.max(0, Math.min(turns.length - 1, (state.pointerY - rect.top) / rect.height - 0.5)))
    } else animatePeak(state.focusIndex ?? currentIndex)
  }

  useEffect(() => { syncPeak() }, [currentIndex, idsKey])
  useEffect(() => () => { cancelAnimationFrame(motion.current.frame); motion.current.frame = 0 }, [])

  // 只在问题集合变化时重新订阅；流式文字和分栏尺寸变化由 ResizeObserver 捕获，每帧最多计算一次。
  useEffect(() => {
    const container = containerRef.current
    if (!container || !questionIds.length) return
    let frame = 0

    /** 使用问题在滚动容器内的实际位置选取当前轮次，容器到底部时选择最后一轮。 */
    function update(): void {
      const anchor = container!.getBoundingClientRect().top + Math.min(80, container!.clientHeight * 0.2)
      let selected = questionIds[0]
      for (const id of questionIds) {
        const node = document.getElementById(`message-${id}`)
        if (node && container!.contains(node) && node.getBoundingClientRect().top <= anchor) selected = id
      }
      if (container!.scrollHeight - container!.scrollTop - container!.clientHeight < 2) selected = questionIds.at(-1)!
      setCurrentId(selected)
    }

    /** 合并连续滚动与布局回调，避免每个事件重复测量所有消息。 */
    function schedule(): void {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; update() })
    }

    const observer = new ResizeObserver(schedule)
    observer.observe(container)
    if (container.firstElementChild) observer.observe(container.firstElementChild)
    container.addEventListener('scroll', schedule, { passive: true })
    schedule()
    return () => { observer.disconnect(); container.removeEventListener('scroll', schedule); cancelAnimationFrame(frame) }
  }, [idsKey, containerRef])

  // 长对话中的当前短线保持在导航可见范围，只滚动导航自身。
  useEffect(() => {
    const nav = navigation.current
    const entry = nav?.querySelector<HTMLElement>('[aria-current="step"]')
    if (!nav || !entry) return
    if (entry.offsetTop < nav.scrollTop) nav.scrollTop = entry.offsetTop
    else if (entry.offsetTop + entry.offsetHeight > nav.scrollTop + nav.clientHeight) nav.scrollTop = entry.offsetTop + entry.offsetHeight - nav.clientHeight
  }, [currentId])

  if (!turns.length) return null
  return <nav ref={navigation} className="message-navigation" aria-label="消息导航"
    onPointerMove={event => {
      if (event.currentTarget.contains(event.target as Node)) { motion.current.pointerY = event.clientY; syncPeak() }
      // Popover 的 Portal 事件仍冒泡到 nav，鼠标进入预览时按离开导航处理。
      else if (motion.current.pointerY !== null) { motion.current.pointerY = null; syncPeak() }
    }}
    onPointerLeave={() => { motion.current.pointerY = null; syncPeak() }}
    onScroll={() => { if (motion.current.pointerY !== null) syncPeak() }}
    onFocusCapture={event => {
      const entry = (event.target as HTMLElement).closest<HTMLElement>('.message-navigation-entry')
      if (entry) { motion.current.focusIndex = Number(entry.dataset.index); syncPeak() }
    }}
    onBlurCapture={() => { motion.current.focusIndex = null; syncPeak() }} onKeyDown={event => {
    if (event.key === 'Escape') { setPreviewId(null); event.stopPropagation() }
  }}>
    {turns.map(({ question, answer }, index) => <Popover key={question.id} trigger={['hover', 'focus']} placement="rightBottom" arrow={false}
      mouseEnterDelay={0.15} mouseLeaveDelay={0.1} destroyOnHidden open={previewId === question.id}
      onOpenChange={open => setPreviewId(current => open ? question.id : current === question.id ? null : current)}
      styles={{ container: { padding: 0, borderRadius: 16, background: 'transparent' } }}
      content={<div className="message-preview" data-theme={theme}>
        <p className="message-preview-question">{question.content.slice(0, 900) || question.attachments?.map(item => item.name).join('、') || '附件'}</p>
        <div className="message-preview-answer">{answer?.content ? <Markdown content={answer.content.slice(0, 900)} /> : answer?.error || (answer?.status === 'streaming' ? '正在生成…' : answer?.status === 'stopped' ? '已停止' : '暂无回复')}</div>
        {Boolean(question.attachments?.length) && <div className="message-preview-attachments"><FileOutlined /><span>{question.attachments!.map(item => item.name).join('、')}</span></div>}
        <div className="message-preview-meta"><span>第 {index + 1} 轮</span><time>{new Date(question.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div>
      </div>}>
      <Button className="message-navigation-entry" data-index={index} type="text" aria-label={`跳转到第 ${index + 1} 轮对话`} aria-current={question.id === currentId ? 'step' : undefined}
        aria-controls={`message-${question.id}`} onClick={() => { setPreviewId(null); onNavigate(question.id) }}>
        <span className="message-navigation-line" aria-hidden="true" />
      </Button>
    </Popover>)}
  </nav>
}
