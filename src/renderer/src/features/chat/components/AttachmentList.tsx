import type { ReactNode } from 'react'
import { Button } from 'antd'
import { CloseOutlined, FileOutlined, FolderOpenOutlined } from '@ant-design/icons'
import type { Attachment } from '../../../../../shared/types'

/** 展示草稿或历史消息的附件摘要，依赖 Workspace 的移除回调；不展开或执行附件内容。 */
export function AttachmentList({ items, disabled, onRemove }: { items: Attachment[]; disabled?: boolean; onRemove?: (id: string) => void }): ReactNode {
  return <div className="attachment-list">{items.map(item => <span className="attachment-chip" key={item.id} title={item.name}>
    {item.kind === 'folder' ? <FolderOpenOutlined /> : <FileOutlined />}
    <span className="attachment-name">{item.name}{item.kind === 'folder' ? ` · ${item.fileCount} 个文件` : ''}</span>
    {onRemove && <Button className="attachment-remove" type="text" disabled={disabled} icon={<CloseOutlined />} aria-label={`移除附件 ${item.name}`} onClick={() => onRemove(item.id)} />}
  </span>)}</div>
}
