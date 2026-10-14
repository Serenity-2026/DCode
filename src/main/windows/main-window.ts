import { BrowserWindow } from 'electron'
import { channels } from '../../shared/channels'
import type { StreamEvent } from '../../shared/types'
import { AgentSessions } from '../services/agent-sessions'
import type { ErrorBoundary } from '../domain/ports'

/** 主窗口生命周期，依赖 AgentSessions 安全停止全部任务，资源路径由启动装配提供；不注册业务 IPC。 */
export class MainWindow {
  private window: BrowserWindow | null = null
  private closing: 'open' | 'stopping' | 'ready' = 'open'

  /** 注入生成服务、构建产物路径与应用错误边界，创建窗口前不加载页面。 */
  constructor(private session: AgentSessions, private paths: { icon: string; preload: string; renderer: string }, private errors: ErrorBoundary) {}

  /** 返回当前窗口引用，供 IPC 来源校验和原生对话框使用。 */
  get current(): BrowserWindow | null { return this.window }

  /** 应用已统一停止并保存任务后，允许退出直接关闭窗口，避免再次拦截退出。 */
  allowClose(): void { this.closing = 'ready' }

  /** 将业务流事件送给有效页面；关闭后不发送，重新创建后自动使用新窗口。 */
  publish(event: StreamEvent): void {
    if (this.window && !this.window.webContents.isDestroyed()) this.window.webContents.send(channels.stream, event)
  }

  /**
   * 使用 Electron BrowserWindow 创建并加载工作台，连接 preload 提供的受限桌面 API。
   * 依赖已初始化的 AgentSessions：关闭窗口前停止所有任务并保存结果；同时限制导航、新窗口与权限请求。
   */
  create(): void {
    this.closing = 'open'
    this.window = new BrowserWindow({
      width: 1280, height: 860, minWidth: 820, minHeight: 620,
      title: 'DCode', backgroundColor: '#fcfcfa', show: false, icon: this.paths.icon,
      titleBarStyle: 'hiddenInset',
      ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 20, y: 19 } } : { titleBarOverlay: { color: '#fcfcfa', symbolColor: '#292929', height: 48 } }),
      webPreferences: { preload: this.paths.preload, contextIsolation: true, sandbox: true, nodeIntegration: false }
    })
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.window.webContents.on('will-navigate', event => event.preventDefault())
    this.window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    this.window.once('ready-to-show', () => this.window?.show())
    // 关闭前停止并保存全部任务；空闲会话也重试此前失败的保存。
    this.window.on('close', event => {
      if (this.closing !== 'ready') {
        event.preventDefault()
        if (this.closing === 'stopping') return
        this.closing = 'stopping'
        this.errors.run('任务停止失败', async () => {
          await this.session.stopAll()
          this.closing = 'ready'
          this.window?.close()
        }, () => { this.closing = 'open' })
      }
    })
    this.window.on('closed', () => { this.window = null })
    this.errors.run('窗口加载失败', () => process.env.ELECTRON_RENDERER_URL
      ? this.window!.loadURL(process.env.ELECTRON_RENDERER_URL)
      : this.window!.loadFile(this.paths.renderer))
  }
}
