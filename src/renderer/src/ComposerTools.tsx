import { type ReactNode } from 'react'
import { Button, ConfigProvider, Dropdown, Progress, Tooltip } from 'antd'
import { UpOutlined, PlusOutlined, FileOutlined, FolderOpenOutlined, ReloadOutlined, SettingOutlined, ThunderboltFilled, ThunderboltOutlined } from '@ant-design/icons'
import type { ReasoningEffort, Snapshot } from '../../shared/types'
import { EffortControl } from './EffortControl'

/** 输入框工具栏，依赖 Workspace 的账号快照与操作回调，Ant Design 提供菜单、圆环和强度滑块。 */
export function ComposerTools({ snapshot, busy, modelsLoading, usedTokens, onAdd, onModel, onRefresh, onSettings, onFastMode, onEffort, sendButton }: {
  snapshot: Snapshot; busy: boolean; modelsLoading: boolean; usedTokens: number
  onAdd: (kind: 'file' | 'folder') => void; onModel: (providerId: string, model: string) => void
  onRefresh: () => void; onSettings: () => void; onFastMode: () => void
  onEffort: (effort: ReasoningEffort | null) => Promise<boolean>; sendButton: ReactNode
}): ReactNode {
  const provider = snapshot.providers.find(item => item.id === snapshot.activeProviderId)
  const detail = snapshot.selectedModel ? provider?.modelDetails?.[snapshot.selectedModel] : undefined
  const contextWindow = detail?.contextWindow
  const percent = contextWindow ? Math.min(100, usedTokens / contextWindow * 100) : undefined
  const choices = snapshot.providers.flatMap(item => item.availableModels.map(model => ({ key: JSON.stringify([item.id, model]), providerId: item.id, model })))
  const dark = snapshot.theme === 'dark'

  return <div className="composer-tools">
    <Dropdown disabled={busy} trigger={['click']} placement="topLeft" menu={{ items: [{ key: 'add', type: 'group', label: '添加', children: [
      { key: 'file', label: '添加文件', icon: <FileOutlined /> }, { key: 'folder', label: '添加文件夹', icon: <FolderOpenOutlined /> }
    ] }], onClick: ({ key }) => { if (key === 'file' || key === 'folder') onAdd(key) } }}>
      <Button className="attachment-add" type="text" disabled={busy} icon={<PlusOutlined />} aria-label="添加附件" />
    </Dropdown>
    <div className="composer-right">
      <ConfigProvider theme={{ components: { Dropdown: {
        colorBgElevated: dark ? '#292c28' : '#ffffff', colorText: dark ? '#edf0eb' : '#292e2a',
        colorTextDescription: dark ? '#abb5ab' : '#687268', colorPrimary: dark ? '#e1eee4' : '#303b33',
        controlItemBgHover: dark ? '#353b35' : '#f4f6f3', controlItemBgActive: dark ? '#3b4a3f' : '#eaf0e9',
        controlItemBgActiveHover: dark ? '#435448' : '#dfe8de', borderRadiusLG: 14
      } } }}>
      <Dropdown disabled={busy} trigger={['click']} placement="topRight" menu={{ style: { maxHeight: 360, overflowY: 'auto' }, selectedKeys: snapshot.selectedModel ? [JSON.stringify([snapshot.activeProviderId, snapshot.selectedModel])] : [], items: [
        ...snapshot.providers.map(item => ({ key: item.id, type: 'group' as const, label: item.name, children: choices.filter(choice => choice.providerId === item.id).map(choice => ({ key: choice.key, label: choice.model })) })),
        { key: 'refresh', label: '刷新模型列表', icon: <ReloadOutlined />, disabled: !snapshot.providers.length },
        { key: 'settings', label: '配置模型服务', icon: <SettingOutlined /> }
      ], onClick: ({ key }) => {
        if (key === 'settings') onSettings()
        else if (key === 'refresh') onRefresh()
        else { const choice = choices.find(item => item.key === key); if (choice) onModel(choice.providerId, choice.model) }
      } }}>
        <Button className="model-selector" type="text" aria-label="切换模型" disabled={busy} loading={modelsLoading}><span className="model-selector-label">{snapshot.selectedModel || '选择模型'}</span><UpOutlined /></Button>
      </Dropdown>
      </ConfigProvider>
      <Tooltip trigger={['hover', 'focus']} styles={{ root: { pointerEvents: 'none' } }} title={<div className="context-tooltip">
        <strong>上下文窗口{percent !== undefined ? ` · ${percent.toFixed(1)}%` : ''}</strong>
        <span>窗口：{contextWindow ? `${contextWindow.toLocaleString()} tokens` : '未知'}</span>
        <span>已用约：{usedTokens.toLocaleString()} tokens</span>
        <span>剩余约：{contextWindow ? `${Math.max(0, contextWindow - usedTokens).toLocaleString()} tokens` : '未知'}</span>
        <span className="context-estimate">预估 · 含草稿与附件</span>
      </div>}>
        <Button className="context-button" type="text" aria-label="上下文用量" data-used={usedTokens} data-limit={contextWindow ?? 'unknown'} data-percent={percent ?? 'unknown'}>
          <Progress type="circle" size={20} strokeWidth={11} percent={percent ?? 0} showInfo={false} strokeColor={percent !== undefined && percent >= 90 ? '#e66b69' : percent !== undefined && percent >= 70 ? '#d5a34e' : '#78978c'} railColor="var(--line)" />
          {percent === undefined && <span className="context-unknown">?</span>}
        </Button>
      </Tooltip>
      <Tooltip title={`${snapshot.fastMode ? '关闭' : '开启'}快速模式 · 仅对支持加速的模型生效`}>
        <Button className="speed-button" style={snapshot.fastMode ? { color: '#1677ff' } : undefined} type="text" disabled={busy} icon={snapshot.fastMode ? <ThunderboltFilled /> : <ThunderboltOutlined />} aria-label="快速模式" aria-pressed={snapshot.fastMode} onClick={onFastMode} />
      </Tooltip>
      <EffortControl key={JSON.stringify([snapshot.activeProviderId, snapshot.selectedModel])} value={snapshot.reasoningEffort} detail={detail} theme={snapshot.theme} disabled={busy || !snapshot.config.configured} onSave={onEffort} />
      {sendButton}
    </div>
  </div>
}
