import { BrowserWindow } from 'electron'
import { channels } from '../../shared/channels'
import type { StreamEvent } from '../../shared/types'
import { Chat } from '../services/chat-service'

/** 主窗口生命周期，依赖 Chat 安全停止生成，资源路径由启动装配提供；不注册业务 IPC。 */
export class MainWindow {
  private window: BrowserWindow | null = null

  /** 注入生成服务与构建产物路径，创建窗口前不加载页面。 */
  constructor(private chat: Chat, private paths: { icon: string; preload: string; renderer: string }) {}

  /** 返回当前窗口引用，供 IPC 来源校验和原生对话框使用。 */
  get current(): BrowserWindow | null { return this.window }

  /** 将业务流事件送给有效页面；关闭后不发送，重新创建后自动使用新窗口。 */
  publish(event: StreamEvent): void {
    if (this.window && !this.window.webContents.isDestroyed()) this.window.webContents.send(channels.stream, event)
  }

  /**
   * 使用 Electron BrowserWindow 创建并加载工作台，连接 preload 提供的受限桌面 API。
   * 依赖已初始化的 Chat：关闭窗口前停止生成并保存结果；同时限制导航、新窗口与权限请求。
   */
  create(): void {
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
    // 生成尚未结束时先等待 Chat.stop 收尾，再真正关闭窗口，避免丢失部分回复。
    this.window.on('close', event => {
      if (this.chat.busy) {
        event.preventDefault()
        void this.chat.stop().finally(() => this.window?.close())
      }
    })
    this.window.on('closed', () => { this.window = null })
    if (process.env.ELECTRON_RENDERER_URL) void this.window.loadURL(process.env.ELECTRON_RENDERER_URL)
    else void this.window.loadFile(this.paths.renderer)
  }
}
