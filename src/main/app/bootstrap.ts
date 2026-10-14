import { app } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../infrastructure/config'
import { Secrets } from '../infrastructure/secrets'
import { ElectronDesktop } from '../infrastructure/electron-desktop'
import { StateRepository } from '../repositories/state-repository'
import { StateService } from '../services/state-service'
import { AgentSession } from '../services/agent-session'
import { AgentSessions } from '../services/agent-sessions'
import { AgentLoop } from '../services/agent-loop'
import { Agent } from '../services/agent'
import { streamModel } from '../infrastructure/model-client'
import { ToolRuntime } from '../infrastructure/tools/tool-runtime'
import { ReadTool } from '../infrastructure/tools/read'
import { BashTool } from '../infrastructure/tools/bash'
import { EditTool } from '../infrastructure/tools/edit'
import { WriteTool } from '../infrastructure/tools/write'
import { Auth } from '../services/auth-service'
import { Models } from '../services/model-service'
import { DesktopService } from '../services/desktop-service'
import { IpcRouter } from '../ipc/ipc-router'
import { MainWindow } from '../windows/main-window'
import { ApplicationErrors } from './application-errors'
import { registerAuthController } from '../controllers/auth-controller'
import { registerModelController } from '../controllers/model-controller'
import { registerChatController } from '../controllers/chat-controller'
import { registerStateController } from '../controllers/state-controller'
import { registerDesktopController } from '../controllers/desktop-controller'

/** 应用装配入口，依次连接 Repository、Service、Controller 和窗口，集中管理 ready、激活和退出。 */
export function startApplication(): void {
  const errors = new ApplicationErrors()
  const here = dirname(fileURLToPath(import.meta.url))
  const icon = app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(here, '../../build/icon.png')
  let session: AgentSessions | undefined
  let windows: MainWindow | undefined
  let quitting: 'idle' | 'stopping' | 'ready' = 'idle'
  errors.run('DCode 无法启动', async () => {
    if (process.env.DCODE_USER_DATA_DIR) app.setPath('userData', process.env.DCODE_USER_DATA_DIR)
    app.setName('DCode')
    await app.whenReady()
    app.dock?.setIcon(icon)
    const userData = app.getPath('userData')
    const config = loadConfig(userData, app.isPackaged)
    const state = new StateService(new StateRepository(join(userData, 'state.json')))
    const secrets = new Secrets()
    const models = new Models(state, secrets, config)
    const auth = new Auth(state, secrets, models)
    await auth.restore()
    const loop = new AgentLoop((config, messages, controller, onDelta, tools) => streamModel(config, messages, controller, onDelta, { tools }))
    const generation = new AgentSessions(state, () => {
      const toolRuntime = new ToolRuntime()
      const tools = [new ReadTool(), new BashTool(), new EditTool(), new WriteTool()].map(tool => toolRuntime.bind(tool))
      const agent = new Agent(loop, tools)
      return { session: new AgentSession(state, event => windows?.publish(event), agent, errors, toolRuntime), dispose: () => toolRuntime.dispose() }
    })
    app.on('will-quit', () => errors.run('临时资源清理失败', () => generation.dispose()))
    session = generation
    const mainWindow = new MainWindow(generation, {
      icon, preload: join(here, '../preload/index.cjs'), renderer: join(here, '../renderer/index.html')
    }, errors)
    windows = mainWindow
    const desktop = new DesktopService(state, new ElectronDesktop(() => mainWindow.current))
    const router = new IpcRouter(() => mainWindow.current)
    registerAuthController(router, auth, generation)
    registerModelController(router, models)
    registerStateController(router, state, generation)
    registerChatController(router, generation, models, state)
    registerDesktopController(router, desktop)
    mainWindow.create()
    app.on('activate', () => errors.run('窗口创建失败', () => { if (!mainWindow.current) mainWindow.create() }))
  }, () => app.quit())

  // 退出前停止并保存任务；重复退出事件仍等待正在进行的收尾。
  app.on('before-quit', event => {
    if (session && quitting !== 'ready') {
      event.preventDefault()
      if (quitting === 'stopping') return
      quitting = 'stopping'
      errors.run('任务停止失败', async () => {
        await session!.stopAll()
        quitting = 'ready'
        windows?.allowClose()
        app.quit()
      }, () => { quitting = 'idle' })
    }
  })
  // macOS 关闭窗口后保留应用，其他平台关闭最后一个窗口即退出。
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
}
