import { app } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../infrastructure/config'
import { Secrets } from '../infrastructure/secrets'
import { ElectronDesktop } from '../infrastructure/electron-desktop'
import { StateRepository } from '../repositories/state-repository'
import { StateService } from '../services/state-service'
import { AgentSession } from '../agent/agent-session'
import { AgentSessions } from '../agent/agent-sessions'
import { AgentLoop } from '../agent/agent-loop'
import { Agent } from '../agent/agent'
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
import { reportError } from './report-error'
import { registerAuthController } from '../controllers/auth-controller'
import { registerModelController } from '../controllers/model-controller'
import { registerChatController } from '../controllers/chat-controller'
import { registerStateController } from '../controllers/state-controller'
import { registerDesktopController } from '../controllers/desktop-controller'
import { registerFileChangeController } from '../controllers/file-change-controller'
import { FileChanges } from '../file/file-changes'
import { Suggestions } from '../services/suggestion-service'

/** 应用装配入口，依次连接 Repository、Service、Controller 和窗口，集中管理 ready、激活和退出。 */
export async function startApplication(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url))
  const icon = app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(here, '../../build/icon.png')
  let session: AgentSessions | undefined
  let windows: MainWindow | undefined
  let quitting: 'idle' | 'stopping' | 'ready' = 'idle'
  // 退出前停止并保存任务；重复退出事件仍等待正在进行的收尾。
  app.on('before-quit', async event => {
    if (session && quitting !== 'ready') {
      event.preventDefault()
      if (quitting === 'stopping') return
      quitting = 'stopping'
      try {
        await session.stopAll()
        quitting = 'ready'
        windows?.allowClose()
        app.quit()
      } catch (error) {
        quitting = 'idle'
        reportError('任务停止失败', error)
      }
    }
  })
  // macOS 关闭窗口后保留应用，其他平台关闭最后一个窗口即退出。
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

  try {
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
    const changes = new FileChanges(state, event => windows?.publish(event))
    await changes.recover()
    const loop = new AgentLoop((config, messages, controller, onDelta, tools) => streamModel(config, messages, controller, onDelta, { tools }))
    const generation = new AgentSessions(state, () => {
      const toolRuntime = new ToolRuntime((turn, path, before, after, write) => changes.record(turn, path, before, after, write))
      const tools = [new ReadTool(), new BashTool(), new EditTool(), new WriteTool()].map(tool => toolRuntime.bind(tool))
      const agent = new Agent(loop, tools)
      const suggestions = new Suggestions(state, event => windows?.publish(event))
      const session = new AgentSession(state, event => windows?.publish(event), agent, error => reportError('任务收尾失败', error), toolRuntime, suggestions)
      return { session, dispose: () => { session.cancelSuggestions(); toolRuntime.dispose() } }
    })
    app.on('will-quit', () => {
      try { generation.dispose() }
      catch (error) { reportError('临时资源清理失败', error) }
    })
    session = generation
    const mainWindow = new MainWindow(generation, {
      icon, preload: join(here, '../preload/index.cjs'), renderer: join(here, '../renderer/index.html')
    }, reportError)
    windows = mainWindow
    //ElectronDesktop 负责“具体怎么操作系统”，DesktopService 负责“业务上应该怎么做”,就像java上的service层和mapper层，MainWindow是窗口实现类
    const desktop = new DesktopService(state, new ElectronDesktop(() => mainWindow.current))
    const router = new IpcRouter(() => mainWindow.current)
    registerAuthController(router, auth, generation)
    registerModelController(router, models)
    registerStateController(router, state, generation)
    registerChatController(router, generation, models, state)
    registerFileChangeController(router, changes, generation)
    registerDesktopController(router, desktop)
    mainWindow.create()
    app.on('activate', () => {
      try { if (!mainWindow.current) mainWindow.create() }
      catch (error) { reportError('窗口创建失败', error) }
    })
  } catch (error) {
    reportError('DCode 无法启动', error)
    app.quit()
  }
}
