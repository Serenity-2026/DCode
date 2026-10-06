import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './app/App'
import './styles.css'

// renderer 启动入口：使用 React createRoot 挂载 app/App.tsx 默认导出的 Root 组件和全局样式。
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
