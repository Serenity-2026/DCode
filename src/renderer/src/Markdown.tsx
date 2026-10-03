import { isValidElement, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { App, Button } from 'antd'
import { CopyOutlined } from '@ant-design/icons'

function CodeBlock({ children }: { children?: ReactNode }): ReactNode {
  const { message } = App.useApp()
  const element = isValidElement<{ children?: ReactNode; className?: string }>(children) ? children : null
  const text = String(element?.props.children || '').replace(/\n$/, '')
  const language = element?.props.className?.replace('language-', '') || 'text'
  return <div className="code-block">
    <div className="code-header"><span>{language}</span><Button type="text" size="small" icon={<CopyOutlined />} aria-label="复制代码" onClick={() => {
      void window.dcode.copyText(text).then(result => result.ok ? message.success('已复制') : message.error(result.error)).catch(() => message.error('复制失败。'))
    }}>复制</Button></div>
    <pre>{children}</pre>
  </div>
}

export function Markdown({ content }: { content: string }): ReactNode {
  const { message } = App.useApp()
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    img: () => null,
    a: ({ href, children }) => <a href={href} onClick={event => {
      event.preventDefault()
      if (href) void window.dcode.openLink(href).then(result => { if (!result.ok) void message.error(result.error) })
    }}>{children}</a>
  }}>{content}</ReactMarkdown></div>
}
