import { useState, type ReactNode } from 'react'
import { Button, Tabs } from 'antd'
import { CloseOutlined, FileTextOutlined, LoadingOutlined } from '@ant-design/icons'
import type { ToolExecution } from '../../../../../shared/types'

/** 展示纯文本和统一差异，逐行着色与编号；文件内容作为文本处理，不执行 HTML。 */
function FileLines({ content, diff = false, startLine = 1 }: { content: string; diff?: boolean; startLine?: number }): ReactNode {
  return <div className="file-code-scroll" tabIndex={0} aria-label={diff ? '文件差异' : '文件内容'}>
    <pre className="file-code" data-diff={diff}>{content.split('\n').map((line, index) => {
      const kind = !diff ? '' : /^(\+\+\+|---|Index:|=)/.test(line) ? 'meta' : line.startsWith('+') ? 'addition' : line.startsWith('-') ? 'deletion' : line.startsWith('@@') ? 'hunk' : ''
      return <span className="file-code-line" data-kind={kind} key={index}>
        {!diff && <span className="file-line-number" aria-hidden="true">{startLine + index}</span>}
        <code>{line || ' '}</code>
      </span>
    })}</pre>
  </div>
}

/** 右侧只读文件面板，使用调用时快照，关闭不影响聊天或正在执行的工具。 */
export function FilePreviewPanel({ tool, onClose }: { tool: ToolExecution; onClose: () => void }): ReactNode {
  const [tab, setTab] = useState(tool.name === 'read' ? 'content' : 'diff')
  const name = tool.path?.split(/[\\/]/).at(-1) || tool.path
  const preview = tool.preview
  const status = { running: '调用中', complete: '已完成', error: '执行失败', stopped: '已停止' }[tool.status]
  return <aside id="file-preview" className="file-preview" aria-label="文件预览" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose() }
  }}>
    <div className="file-preview-header"><FileTextOutlined /><strong title={tool.path}>{name}</strong>
      <Button type="text" size="small" icon={<CloseOutlined />} aria-label="关闭文件预览" onClick={onClose} />
    </div>
    <div className="file-preview-path" title={tool.path}>{tool.path}</div>
    {preview ? <Tabs className="file-preview-tabs" classNames={{ header: 'file-preview-tabbar', body: 'file-preview-tabbody', content: 'file-preview-tabcontent' }} size="small" activeKey={preview.diff === undefined ? 'content' : tab} onChange={setTab}
      items={[
        ...(preview.diff !== undefined ? [{ key: 'diff', label: '修改', children: <FileLines content={preview.diff} diff /> }] : []),
        { key: 'content', label: '内容', children: <FileLines content={preview.content} startLine={preview.startLine} /> }
      ]} /> : <div className="file-preview-empty">{tool.status === 'running' ? <><LoadingOutlined spin />正在调用 {tool.name} 工具</> : '没有可用的文本预览'}</div>}
    <footer className="file-preview-footer"><span>{tool.name} · {status}</span>
      {preview?.totalLines !== undefined && <span>{preview.totalLines} 行</span>}
      {preview?.truncated && <span>部分内容</span>}
    </footer>
  </aside>
}
