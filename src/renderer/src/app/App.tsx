import { useEffect, useState, type ReactNode } from 'react'
import { Alert, App as AntApp, ConfigProvider, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import type { Snapshot } from '../../../shared/types'
import { AuthScreen } from '../features/auth/AuthScreen'
import { Workspace } from '../features/chat/Workspace'

/**
 * 界面根组件：通过 preload 的 window.dcode 读取 Snapshot，并配置 Ant Design 主题与提示容器。
 * 根据登录快照渲染 AuthScreen 或 Workspace；不直接访问主进程的 StateService、Auth 或 Chat。
 */
export default function Root(): ReactNode {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState('')
  // 首次挂载时取得主进程快照；连接或读取失败时显示错误，不创建虚假的本地状态。
  useEffect(() => {
    void window.dcode.getState().then(result => {
      if (result.ok) setSnapshot(result.value)
      else setError(result.error)
    }).catch(() => setError('无法连接桌面服务，请重启应用。'))
  }, [])
  const dark = snapshot?.theme === 'dark'
  return <ConfigProvider locale={zhCN} button={{ autoInsertSpace: false }} theme={{
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: { colorPrimary: dark ? '#8ac8a3' : '#303b33', borderRadius: 8, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif' }
  }}><AntApp>
    {snapshot ? snapshot.activeUserId ? <Workspace key={snapshot.activeUserId} snapshot={snapshot} setSnapshot={setSnapshot} /> : <AuthScreen onLogin={setSnapshot} /> : error ? <div className="load-error"><Alert title={error} type="error" showIcon /></div> : <div className="loading">正在打开工作台…</div>}
  </AntApp></ConfigProvider>
}
