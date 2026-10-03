import { contextBridge, ipcRenderer } from 'electron'
import { channels } from '../shared/channels'
import type { DCodeAPI, StreamEvent } from '../shared/types'

const api: DCodeAPI = {
  getState: () => ipcRenderer.invoke(channels.state),
  action: (action) => ipcRenderer.invoke(channels.action, action),
  send: (input) => ipcRenderer.invoke(channels.send, input),
  stop: () => ipcRenderer.invoke(channels.stop),
  openLink: (url) => ipcRenderer.invoke(channels.openLink, url),
  copyText: (text) => ipcRenderer.invoke(channels.copyText, text),
  onStream: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, data: StreamEvent): void => callback(data)
    ipcRenderer.on(channels.stream, listener)
    return () => { ipcRenderer.removeListener(channels.stream, listener) }
  }
}

contextBridge.exposeInMainWorld('dcode', api)
