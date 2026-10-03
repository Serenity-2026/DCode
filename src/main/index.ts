import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
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

void app.whenReady().then(() => {
  const config = loadConfig(app.getPath('userData'), app.isPackaged)
  const store = new Store(join(app.getPath('userData'), 'state.json'))
  chat = new Chat(store, config, event => {
    if (window && !window.webContents.isDestroyed()) window.webContents.send(channels.stream, event)
  })
  function handle<T = void>(channel: string, handler: (input: T) => unknown): void {
    ipcMain.handle(channel, async (event, input): Promise<Result<unknown>> => {
      try {
        if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无权执行此操作。')
        return { ok: true, value: await handler(input) }
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : '操作失败。' } }
    })
  }
  handle(channels.state, () => store.snapshot(config))
  handle<Action>(channels.action, input => {
    if (chat.busy) throw new Error('请先停止当前生成。')
    store.apply(input)
    return store.snapshot(config)
  })
  handle<{ content: string; retry?: boolean }>(channels.send, input => chat.send(input))
  handle(channels.stop, () => chat.stop())
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

app.on('before-quit', event => {
  if (chat?.busy && !quitting) {
    event.preventDefault()
    quitting = true
    void chat.stop().finally(() => app.quit())
  }
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
