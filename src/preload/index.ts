import { contextBridge, ipcRenderer } from 'electron'
import { channels } from '../shared/channels'
import type { DCodeAPI, StreamEvent } from '../shared/types'

/**
 * 窗口通过webPreferences: { preload: this.paths.preload }加载,给window提供额外可调用的api
 * 执行后，React 页面里就能使用：
 * window.dcode.getState()
 * window.dcode.send(...)
 * 执行contextBridge.exposeInMainWorld后，React 页面里就能使用：window.dcode.getState()然后被ipcrouter捕捉
 */
const api: DCodeAPI = {
  listMcpServers: () => ipcRenderer.invoke(channels.listMcpServers),
  saveMcpServer: input => ipcRenderer.invoke(channels.saveMcpServer, input),
  mcpAction: input => ipcRenderer.invoke(channels.mcpAction, input),
  /** 向主进程请求 StateService.snapshot，用于首次加载界面。 */
  getState: () => ipcRenderer.invoke(channels.state),
  /** 由 Auth 注册并加密保存保持登录的令牌。 */
  register: (input) => ipcRenderer.invoke(channels.register, input),
  /** 由 Auth 验证密码后恢复账号数据。 */
  login: (input) => ipcRenderer.invoke(channels.login, input),
  /** 撤销 Auth 的登录会话。 */
  logout: () => ipcRenderer.invoke(channels.logout),
  /** Models 获取有效模型列表后才保存服务地址与密钥。 */
  saveProvider: (input) => ipcRenderer.invoke(channels.saveProvider, input),
  /** 由 Models 解密当前账号服务的密钥并刷新模型列表。 */
  refreshModels: () => ipcRenderer.invoke(channels.refreshModels),
  /** 将用户、会话或主题 Action 交给主进程的 StateService.apply。 */
  action: (action) => ipcRenderer.invoke(channels.action, action),
  /** 由主进程选择或复用已保存的工作目录，再创建空会话。 */
  createConversation: (sourceId) => ipcRenderer.invoke(channels.createConversation, sourceId),
  /** 新项目位置只来自主进程的原生选择器。 */
  selectProjectDirectory: () => ipcRenderer.invoke(channels.selectProjectDirectory),
  /** 主进程创建项目目录和首段空会话，页面不直接写入文件系统。 */
  createProject: (input) => ipcRenderer.invoke(channels.createProject, input),
  /** 请求主进程的 AgentSessions.send 开始或重试生成，返回初始快照。 */
  send: (input) => ipcRenderer.invoke(channels.send, input),
  /** 由主进程打开系统选择器并读取已选择的文本，不提供通用文件系统权限。 */
  selectAttachments: (kind) => ipcRenderer.invoke(channels.selectAttachments, kind),
  /** 请求 AgentSessions.stop 取消指定会话的任务，等待主进程保存后获取最终快照。 */
  stop: (conversationId) => ipcRenderer.invoke(channels.stop, conversationId),
  /** 撤销指定回复中的文件修改，主进程核对账号归属和磁盘当前内容。 */
  undoFiles: (input) => ipcRenderer.invoke(channels.undoFiles, input),
  /** 将链接交给主进程校验，再由 Electron shell 打开系统浏览器。 */
  openLink: (url) => ipcRenderer.invoke(channels.openLink, url),
  /** 将文本交给主进程的 Electron clipboard 复制，不暴露剪贴板读取能力。 */
  copyText: (text) => ipcRenderer.invoke(channels.copyText, text),
  /** 订阅 AgentSession 推送的 StreamEvent；返回退订函数，供 React effect 卸载时清理监听。 */
  onStream: (callback) => {
    // 只将业务数据传给回调，避免暴露 Electron 事件对象及其 sender。
    const listener = (_event: Electron.IpcRendererEvent, data: StreamEvent): void => callback(data)
    ipcRenderer.on(channels.stream, listener)
    return () => { ipcRenderer.removeListener(channels.stream, listener) }
  }
}
/**
 * contextBridge	Electron 提供的跨 JavaScript 上下文桥接工具
 * exposeInMainWorld	把指定接口提供给页面自己的 JavaScript 环境
 * 'dcode'	页面访问这个接口时使用的名字
 * api	要提供给页面的对象和方法
 */
contextBridge.exposeInMainWorld('dcode', api)
