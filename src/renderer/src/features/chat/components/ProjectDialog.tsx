import { useState, type ReactNode } from 'react'
import { Alert, Button, Input, Modal } from 'antd'
import type { Snapshot } from '../../../../../shared/types'

/** 项目创建表单；通过受限桌面接口选择位置和创建目录，不在页面操作文件系统。 */
export function ProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (snapshot: Snapshot) => void }): ReactNode {
  const [name, setName] = useState('')
  const [parentDirectory, setParentDirectory] = useState<string>()
  const [selecting, setSelecting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const busy = selecting || saving

  /** 取消选择保留表单中的位置和名称，错误留在表单内便于修正。 */
  async function selectDirectory(): Promise<void> {
    if (busy) return
    setSelecting(true); setError('')
    try {
      const result = await window.dcode.selectProjectDirectory()
      if (!result.ok) setError(result.error)
      else if (result.value) setParentDirectory(result.value)
    } catch { setError('选择文件夹失败，请重试。') }
    finally { setSelecting(false) }
  }

  /** 只有主进程确认目录和会话都已创建后，才关闭表单并进入新项目。 */
  async function create(): Promise<void> {
    if (busy || !name.trim()) return
    setSaving(true); setError('')
    try {
      const result = await window.dcode.createProject({ name, parentDirectory })
      if (result.ok) onCreated(result.value)
      else setError(result.error)
    } catch { setError('创建项目失败，请重试。') }
    finally { setSaving(false) }
  }

  return <Modal title="创建项目" open centered width={440} onCancel={onClose} onOk={() => void create()} okText="创建项目" cancelText="取消"
    confirmLoading={saving} okButtonProps={{ disabled: busy || !name.trim() }} cancelButtonProps={{ disabled: busy }} closable={!busy} keyboard={!busy} mask={{ closable: !busy }}>
    <div className="project-form">
      <label htmlFor="project-name">项目名</label>
      <Input id="project-name" aria-label="项目名" autoFocus maxLength={80} value={name} disabled={busy} onChange={event => { setName(event.target.value); setError('') }} onPressEnter={() => void create()} />
      <label>创建位置</label>
      <div className="project-location"><span title={parentDirectory}>{parentDirectory || '默认工作区'}</span><Button disabled={saving} loading={selecting} onClick={() => void selectDirectory()}>选择文件夹</Button></div>
      {error && <Alert title={error} type="error" showIcon />}
    </div>
  </Modal>
}
