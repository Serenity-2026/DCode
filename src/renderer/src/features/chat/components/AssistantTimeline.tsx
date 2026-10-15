import { Fragment, type ReactNode } from 'react'
import { Button } from 'antd'
import { CodeOutlined, EditOutlined, FileAddOutlined, FileTextOutlined } from '@ant-design/icons'
import type { Message, ToolExecution } from '../../../../../shared/types'
import { Markdown } from './Markdown'

/** 按正文偏移穿插工具行；调用开始即出现，文件链接打开该次调用的预览。 */
export function AssistantTimeline({ message, selectedToolId, onPreview }: {
  message: Message; selectedToolId?: string; onPreview: (tool: ToolExecution) => void
}): ReactNode {
  let cursor = 0
  const entries = (message.toolExecutions || []).map(tool => {
    const offset = Math.max(cursor, Math.min(tool.offset ?? message.content.length, message.content.length))
    const text = message.content.slice(cursor, offset)
    cursor = offset
    const running = tool.status === 'running'
    const fileTool = ['read', 'write', 'edit'].includes(tool.name)
    const name = tool.path?.split(/[\\/]/).at(-1) || tool.path
    const icon = tool.name === 'read' ? <FileTextOutlined />
      : tool.name === 'write' ? <FileAddOutlined /> : tool.name === 'edit' ? <EditOutlined /> : <CodeOutlined />
    const status = { running: '正在执行', complete: '执行成功', error: '执行失败', stopped: '已停止' }[tool.status]
    return <Fragment key={tool.id}>
      {text && <Markdown content={text} />}
      <div className="tool-call" data-tool-id={tool.id} data-tool-status={tool.status}
        role={running ? 'status' : 'group'} aria-label={running ? '工具执行状态' : '工具调用记录'}>
        <div className="tool-call-header">
          <span className="tool-call-dot" role="img" aria-label={status} title={status} />
          <span className="tool-call-icon" aria-hidden="true" title={tool.name}>{icon}</span>
          {(!fileTool || !tool.path) && <>
            {running && <span>正在调用</span>}
            <code className="tool-call-name">{tool.name}</code>
            {running && <span>工具</span>}
          </>}
          {tool.path && <Button className="tool-file-link" type="link" href="#file-preview"
            title={tool.path} aria-label={`预览文件 ${name}`} aria-controls="file-preview" aria-expanded={selectedToolId === tool.id}
            onClick={event => { event.preventDefault(); onPreview(tool) }}>{name}</Button>}
        </div>
        {tool.name === 'bash' && tool.command !== undefined && <pre className="tool-call-command"><code>{tool.command}</code></pre>}
      </div>
    </Fragment>
  })
  const tail = message.content.slice(cursor)
  return <div className="assistant-timeline">{entries}{tail && <Markdown content={tail} />}</div>
}
