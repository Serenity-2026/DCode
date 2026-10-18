import { BrowserWindow } from 'electron'
import { channels } from '../../shared/channels'
import type { StreamEvent } from '../../shared/types'
import { AgentSessions } from '../agent/agent-sessions'

/** 主窗口生命周期，依赖 AgentSessions 安全停止全部任务，资源路径由启动装配提供；不注册业务 IPC。 */
export class MainWindow {
  private window: BrowserWindow | null = null
  private closing: 'open' | 'stopping' | 'ready' = 'open'

  /** 注入生成服务、构建产物路径与应用报告回调，创建窗口前不加载页面。 */
  constructor(private session: AgentSessions, private paths: { icon: string; preload: string; renderer: string }, private reportError: (title: string, error: unknown) => void) {}

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
    //todo:当前版本没有使用这些权限的功能，因此默认拒绝；后续增加功能时，应配套增加权限申请与授权规则。
    this.window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    this.window.once('ready-to-show', () => this.window?.show())
    // 关闭前停止并保存全部任务；空闲会话也重试此前失败的保存。
    this.window.on('close', async event => {
      if (this.closing !== 'ready') {
        event.preventDefault()
        if (this.closing === 'stopping') return
        this.closing = 'stopping'
        try {
          await this.session.stopAll()
          this.closing = 'ready'
          this.window?.close()
        } catch (error) {
          this.closing = 'open'
          this.reportError('任务停止失败', error)
        }
      }
    })
    this.window.on('closed', () => { this.window = null })
    void this.loadPage()
  }

  /** 等待页面加载并捕获拒绝，创建窗口的同步调用方无需等待页面完成。 */
  private async loadPage(): Promise<void> {
    try {
      if (process.env.ELECTRON_RENDERER_URL) await this.window!.loadURL(process.env.ELECTRON_RENDERER_URL)
      else await this.window!.loadFile(this.paths.renderer)
    } catch (error) { this.reportError('窗口加载失败', error) }
  }
}
