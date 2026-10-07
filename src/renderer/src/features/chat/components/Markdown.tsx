import { isValidElement, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { App, Button } from 'antd'
import { CopyOutlined } from '@ant-design/icons'

/**
 * 为 Markdown 的代码块显示语言标签和复制按钮，依赖 React 元素检查与 Ant Design 提示/按钮。
 * 复制通过 window.dcode.copyText 交给主进程 clipboard，不在 renderer 直接访问系统能力。
 */
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

/**
 * 安全展示模型文本，依赖 ReactMarkdown、remarkGfm 和 CodeBlock 支持代码块与表格。
 * 跳过原始 HTML 和图片；链接交给 window.dcode.openLink 在主进程校验后打开。
 */
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
