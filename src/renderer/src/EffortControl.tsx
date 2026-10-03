import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { Button, Popover, Slider } from 'antd'
import { SlidersOutlined } from '@ant-design/icons'
import { normalizeEffort, resolveEffort, strengthLevels } from '../../shared/context'
import type { ModelDetails, ReasoningEffort, Theme } from '../../shared/types'

/** 五档强度面板；依赖共享映射规则与 Workspace 保存回调，Ant Design 提供浮层、按钮和连续滑块。 */
export function EffortControl({ value, detail, theme, disabled, onSave }: {
  value: ReasoningEffort | null; detail?: ModelDetails; theme: Theme; disabled: boolean
  onSave: (effort: ReasoningEffort | null) => Promise<boolean>
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<number>(strengthLevels.indexOf(normalizeEffort(value)))
  const [dragging, setDragging] = useState(false)
  const saving = useRef(false)
  useEffect(() => setPosition(strengthLevels.indexOf(normalizeEffort(value))), [value])
  const index = Math.max(0, Math.min(4, Math.round(position)))
  const level = strengthLevels[index]
  const requestEffort = resolveEffort(level, detail)

  /** 拖动释放或点击整档时仅保存一次；数字取整避免连续值产生 undefined IPC，失败恢复账号快照。 */
  async function commit(next: number): Promise<void> {
    if (disabled || saving.current) return
    const snapped = Math.max(0, Math.min(4, Math.round(next)))
    setDragging(false)
    setPosition(snapped)
    if (strengthLevels[snapped] === normalizeEffort(value)) return
    saving.current = true
    try {
      if (!await onSave(strengthLevels[snapped])) setPosition(strengthLevels.indexOf(normalizeEffort(value)))
    } finally { saving.current = false }
  }

  /** 连续滑块的键盘输入按整档提交，避免 0.001 步长迫使键盘用户按上千次。 */
  function keyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const delta = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[event.key]
    if (delta === undefined && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    event.stopPropagation()
    void commit(event.key === 'Home' ? 0 : event.key === 'End' ? 4 : index + (delta || 0))
  }

  return <Popover trigger="click" placement="topRight" arrow={false} open={open} onOpenChange={setOpen}
    styles={{ container: { padding: 0, borderRadius: 20, overflow: 'hidden' } }}
    content={<div className="strength-panel" data-theme={theme} data-dragging={dragging} onKeyDown={event => {
      if (event.key === 'Escape') { setOpen(false); event.stopPropagation() }
    }}
      style={{ '--strength-color': `hsl(${195 + position * 20} 72% 61%)`, '--strength-position': `${position * 100}%` } as CSSProperties}>
      <div className="strength-heading"><span>模型强度</span><strong>{level}</strong></div>
      <div className="strength-slider-wrap" onKeyDownCapture={keyDown} onKeyUpCapture={event => {
        if (['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'Home', 'End'].includes(event.key)) event.stopPropagation()
      }}>
        <Slider className="strength-slider" classNames={{ rail: 'strength-rail', track: 'strength-track', handle: 'strength-handle' }}
          min={0} max={4} step={0.001} value={position} disabled={disabled} tooltip={{ open: false }}
          ariaLabelForHandle="模型强度" ariaValueTextFormatterForHandle={number => strengthLevels[Math.round(number)]}
          onChange={next => { setDragging(true); setPosition(next) }} onChangeComplete={next => void commit(next)} />
        <div className="strength-ticks" aria-hidden="true">{strengthLevels.map(item => <span key={item} />)}</div>
      </div>
      <div className="strength-levels">
        <span className="strength-selection" aria-hidden="true" />
        {strengthLevels.map((item, i) => <Button key={item} type="text" className="strength-level" disabled={disabled} aria-pressed={index === i} onClick={() => void commit(i)}>{item}</Button>)}
      </div>
      {requestEffort !== level && <div className="strength-request">请求：{requestEffort || '不支持推理'}</div>}
    </div>}>
    <Button className="strength-trigger" type="text" disabled={disabled} icon={<SlidersOutlined />} aria-label="模型强度选择" aria-expanded={open} onKeyDown={event => { if (event.key === 'Escape') setOpen(false) }}>
      {normalizeEffort(value)}
    </Button>
  </Popover>
}
