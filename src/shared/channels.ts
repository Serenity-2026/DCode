/** 主进程和 preload 共用的 IPC 通道名称，保证 DCodeAPI 的请求与流事件使用同一套映射。 */
export const channels = {
  state: 'dcode:state',
  register: 'dcode:register',
  login: 'dcode:login',
  logout: 'dcode:logout',
  saveProvider: 'dcode:save-provider',
  refreshModels: 'dcode:refresh-models',
  action: 'dcode:action',
  send: 'dcode:send',
  stop: 'dcode:stop',
  stream: 'dcode:stream',
  openLink: 'dcode:open-link',
  copyText: 'dcode:copy-text'
} as const
