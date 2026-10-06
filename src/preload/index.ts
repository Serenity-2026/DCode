import { contextBridge, ipcRenderer } from 'electron'
import { channels } from '../shared/channels'
import type { DCodeAPI, StreamEvent } from '../shared/types'

/**
 * renderer 与主进程之间的白名单桥接对象，实现 shared/types 定义的 DCodeAPI。
 * 依赖 Electron ipcRenderer 和共享 channels；contextBridge 只暴露这些业务方法，
 * 不把原始 IPC 对象、Node API 或模型密钥交给界面。
 */
const api: DCodeAPI = {
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
  /** 请求主进程的 Chat.send 开始或重试生成，返回初始快照。 */
  send: (input) => ipcRenderer.invoke(channels.send, input),
  /** 由主进程打开系统选择器并读取已选择的文本，不提供通用文件系统权限。 */
  selectAttachments: (kind) => ipcRenderer.invoke(channels.selectAttachments, kind),
  /** 请求 Chat.stop 取消生成，等待主进程保存后获取最终快照。 */
  stop: () => ipcRenderer.invoke(channels.stop),
  /** 将链接交给主进程校验，再由 Electron shell 打开系统浏览器。 */
  openLink: (url) => ipcRenderer.invoke(channels.openLink, url),
  /** 将文本交给主进程的 Electron clipboard 复制，不暴露剪贴板读取能力。 */
  copyText: (text) => ipcRenderer.invoke(channels.copyText, text),
  /** 订阅 Chat 推送的 StreamEvent；返回退订函数，供 React effect 卸载时清理监听。 */
  onStream: (callback) => {
    // 只将业务数据传给回调，避免暴露 Electron 事件对象及其 sender。
    const listener = (_event: Electron.IpcRendererEvent, data: StreamEvent): void => callback(data)
    ipcRenderer.on(channels.stream, listener)
    return () => { ipcRenderer.removeListener(channels.stream, listener) }
  }
}

contextBridge.exposeInMainWorld('dcode', api)
