import type { ReactNode } from 'react'
import { Button } from 'antd'
import { FileTextOutlined, UndoOutlined } from '@ant-design/icons'
import type { FileChange } from '../../../../../shared/types'

/** 每轮回复底部的文件净变更列表，逐文件预览和撤销，顶部撤销本轮剩余修改。 */
export function FileChangesCard({ changes, disabled, loading, onUndo, onView }: {
  changes: FileChange[]; disabled: boolean; loading: boolean
  onUndo: (changeId?: string) => void; onView: (change: FileChange) => void
}): ReactNode {
  const remaining = changes.filter(change => change.status !== 'reverted')
  const additions = changes.reduce((sum, change) => sum + change.additions, 0)
  const deletions = changes.reduce((sum, change) => sum + change.deletions, 0)
  return <section className="file-changes-card" aria-label="本轮文件变更">
    <div className="file-changes-header">
      <span className="file-changes-icon" aria-hidden="true"><FileTextOutlined /></span>
      <div className="file-changes-heading"><strong>{remaining.length ? '已编辑' : '已撤销'} {changes.length} 个文件</strong>
        <span className="file-changes-counts"><span className="file-additions">+{additions}</span><span className="file-deletions">-{deletions}</span></span>
      </div>
      <div className="file-changes-actions">
        <Button type="text" icon={<UndoOutlined />} iconPlacement="end" aria-label="撤销本轮修改" disabled={disabled || !remaining.length} loading={loading} onClick={() => onUndo()}>撤销</Button>
        <Button className="file-changes-view" onClick={() => onView(remaining[0] || changes[0])}>查看变更</Button>
      </div>
    </div>
    <ul className="file-changes-list">{changes.map(change => {
      const slash = Math.max(change.path.lastIndexOf('/'), change.path.lastIndexOf('\\'))
      return <li className="file-change-row" key={change.id} data-status={change.status}>
        <Button className="file-change-path" type="text" title={change.path} aria-label={`查看变更 ${change.path}`} onClick={() => onView(change)}>
          <span><span className="file-change-directory">{change.path.slice(0, slash + 1)}</span>{change.path.slice(slash + 1)}</span>
        </Button>
        {change.status === 'reverted' ? <span className="file-change-status">已撤销</span> : <Button className="file-change-undo" type="text" size="small" icon={<UndoOutlined />} title="撤销此文件" aria-label={`撤销文件 ${change.path}`} disabled={disabled || change.status === 'pending'} onClick={() => onUndo(change.id)} />}
        <span className="file-changes-counts"><span className="file-additions">+{change.additions}</span><span className="file-deletions">-{change.deletions}</span></span>
      </li>
    })}</ul>
  </section>
}
