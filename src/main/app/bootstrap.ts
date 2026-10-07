import { app, dialog } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../infrastructure/config'
import { Secrets } from '../infrastructure/secrets'
import { ElectronDesktop } from '../infrastructure/electron-desktop'
import { StateRepository } from '../repositories/state-repository'
import { StateService } from '../services/state-service'
import { AgentSession } from '../services/agent-session'
import { AgentLoop } from '../services/agent-loop'
import { Agent } from '../services/agent'
import { streamModel } from '../infrastructure/model-client'
import { Auth } from '../services/auth-service'
import { Models } from '../services/model-service'
import { DesktopService } from '../services/desktop-service'
import { IpcRouter } from '../ipc/ipc-router'
import { MainWindow } from '../windows/main-window'
import { registerAuthController } from '../controllers/auth-controller'
import { registerModelController } from '../controllers/model-controller'
import { registerChatController } from '../controllers/chat-controller'
import { registerStateController } from '../controllers/state-controller'
import { registerDesktopController } from '../controllers/desktop-controller'

/** 应用装配入口，依次连接 Repository、Service、Controller 和窗口，集中管理 ready、激活和退出。 */
export function startApplication(): void {
  const here = dirname(fileURLToPath(import.meta.url))
  const icon = app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(here, '../../build/icon.png')
  let session: AgentSession | undefined
  let windows: MainWindow | undefined
  let quitting = false
  if (process.env.DCODE_USER_DATA_DIR) app.setPath('userData', process.env.DCODE_USER_DATA_DIR)
  app.setName('DCode')

  void app.whenReady().then(async () => {
    app.dock?.setIcon(icon)
    const userData = app.getPath('userData')
    const config = loadConfig(userData, app.isPackaged)
    const state = new StateService(new StateRepository(join(userData, 'state.json')))
    const secrets = new Secrets()
    const models = new Models(state, secrets, config)
    const auth = new Auth(state, secrets, models)
    await auth.restore()
    const loop = new AgentLoop((config, messages, controller, onDelta, tools) => streamModel(config, messages, controller, onDelta, { tools }))
    const agent = new Agent(loop, [])
    const generation = new AgentSession(state, event => windows?.publish(event), agent)
    session = generation
    const mainWindow = new MainWindow(generation, {
      icon, preload: join(here, '../preload/index.cjs'), renderer: join(here, '../renderer/index.html')
    })
    windows = mainWindow
    const desktop = new DesktopService(state, new ElectronDesktop(() => mainWindow.current))
    const router = new IpcRouter(() => mainWindow.current, () => generation.busy)
    registerAuthController(router, auth)
    registerModelController(router, models)
    registerStateController(router, state)
    registerChatController(router, generation, models, state)
    registerDesktopController(router, desktop)
    mainWindow.create()
    app.on('activate', () => { if (!mainWindow.current) mainWindow.create() })
  }).catch(error => {
    dialog.showErrorBox('DCode 无法启动', error instanceof Error ? error.message : '初始化失败。')
    app.quit()
  })

  // 退出前等待生成服务保存；再次触发退出时不重复等待。
  app.on('before-quit', event => {
    if (session?.busy && !quitting) {
      event.preventDefault()
      quitting = true
      void session.stop().finally(() => app.quit())
    }
  })
  // macOS 关闭窗口后保留应用，其他平台关闭最后一个窗口即退出。
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
}
