import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { channels } from '../shared/channels'
import type { Action, Result } from '../shared/types'
import { loadConfig } from './config'
import { Store } from './store'
import { Chat } from './chat'

const here = dirname(fileURLToPath(import.meta.url))
let window: BrowserWindow | null = null
let chat: Chat
let quitting = false
if (process.env.DCODE_USER_DATA_DIR) app.setPath('userData', process.env.DCODE_USER_DATA_DIR)
app.setName('DCode')

/**
 * 使用 Electron BrowserWindow 创建并加载工作台，连接 preload 提供的受限桌面 API。
 * 依赖已初始化的 Chat：关闭窗口前停止生成并保存结果；同时限制导航、新窗口与权限请求。
 */
function createWindow(): void {
  window = new BrowserWindow({
    width: 1280, height: 860, minWidth: 820, minHeight: 620,
    title: 'DCode', backgroundColor: '#fcfcfa', show: false,
    titleBarStyle: 'hiddenInset',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 20, y: 19 } } : { titleBarOverlay: { color: '#fcfcfa', symbolColor: '#292929', height: 48 } }),
    webPreferences: { preload: join(here, '../preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  window.once('ready-to-show', () => window?.show())
  // 生成尚未结束时先等待 Chat.stop 收尾，再真正关闭窗口，避免丢失部分回复。
  window.on('close', event => {
    if (chat.busy) {
      event.preventDefault()
      void chat.stop().finally(() => window?.close())
    }
  })
  window.on('closed', () => { window = null })
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(here, '../renderer/index.html'))
}

/**
 * 主进程启动流程：loadConfig 读取配置，Store 恢复数据，Chat 管理生成任务。
 * 注册 IPC 后调用 createWindow；Chat 的 emit 回调通过 webContents 将流事件交给 preload。
 */
void app.whenReady().then(() => {
  const config = loadConfig(app.getPath('userData'), app.isPackaged)
  const store = new Store(join(app.getPath('userData'), 'state.json'))
  chat = new Chat(store, config, event => {
    if (window && !window.webContents.isDestroyed()) window.webContents.send(channels.stream, event)
  })
  /**
   * 封装 ipcMain.handle：仅接受当前窗口主 frame 的调用，再交给对应业务处理函数。
   * 统一返回 shared/types 的 Result，使 preload/renderer 能按相同方式处理成功与错误。
   */
  function handle<T = void>(channel: string, handler: (input: T) => unknown): void {
    ipcMain.handle(channel, async (event, input): Promise<Result<unknown>> => {
      try {
        if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无权执行此操作。')
        return { ok: true, value: await handler(input) }
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : '操作失败。' } }
    })
  }
  // 读取当前用户的界面快照，数据由 Store 提供，配置敏感字段在 snapshot 中过滤。
  handle(channels.state, () => store.snapshot(config))
  // 用户、会话与主题操作交给 Store.apply；Chat 生成期间禁止修改会话状态。
  handle<Action>(channels.action, input => {
    if (chat.busy) throw new Error('请先停止当前生成。')
    store.apply(input)
    return store.snapshot(config)
  })
  // 开始/重试生成由 Chat.send 处理，后续内容经独立的 stream 通道推送。
  handle<{ content: string; retry?: boolean }>(channels.send, input => chat.send(input))
  // 停止生成由 Chat.stop 取消请求并返回保存后的快照。
  handle(channels.stop, () => chat.stop())
  // 通过 Electron clipboard 复制文本，界面无需获得通用剪贴板或文件系统权限。
  handle<string>(channels.copyText, input => {
    if (typeof input !== 'string' || input.length > 1_000_000) throw new Error('复制内容无效或过长。')
    return clipboard.writeText(input)
  })
  // 校验链接协议后使用 Electron shell 在系统浏览器打开，不让工作台跳转到外部网页。
  handle(channels.openLink, async (input: unknown) => {
    if (typeof input !== 'string') throw new Error('链接无效。')
    const url = new URL(input)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('仅支持 HTTP 或 HTTPS 链接。')
    await shell.openExternal(url.toString())
  })
  createWindow()
  app.on('activate', () => { if (!window) createWindow() })
}).catch(error => {
  dialog.showErrorBox('DCode 无法启动', error instanceof Error ? error.message : '初始化失败。')
  app.quit()
})

/** 应用退出前等待 Chat.stop 完成保存；quitting 防止再次触发退出事件时重复等待。 */
app.on('before-quit', event => {
  if (chat?.busy && !quitting) {
    event.preventDefault()
    quitting = true
    void chat.stop().finally(() => app.quit())
  }
})
/** 遵循桌面平台习惯：非 macOS 关闭全部窗口即退出，macOS 保留应用等待再次激活。 */
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
