import { useEffect, useState, type ReactNode } from 'react'
import { Button, Dropdown, Progress, Slider, Tooltip } from 'antd'
import { DownOutlined, PlusOutlined, FileOutlined, FolderOpenOutlined, ReloadOutlined, SettingOutlined, ThunderboltFilled, ThunderboltOutlined } from '@ant-design/icons'
import type { ReasoningEffort, Snapshot } from '../../shared/types'
import { modelEfforts } from '../../shared/context'

const effortLabels: Record<ReasoningEffort, string> = { minimal: '最轻', low: '轻量', medium: '标准', high: '深入', xhigh: '更高', max: '极致' }

/** 输入框工具栏，依赖 Workspace 的账号快照与操作回调，Ant Design 提供菜单、圆环和强度滑块。 */
export function ComposerTools({ snapshot, busy, modelsLoading, usedTokens, onAdd, onModel, onRefresh, onSettings, onFastMode, onEffort, sendButton }: {
  snapshot: Snapshot; busy: boolean; modelsLoading: boolean; usedTokens: number
  onAdd: (kind: 'file' | 'folder') => void; onModel: (providerId: string, model: string) => void
  onRefresh: () => void; onSettings: () => void; onFastMode: () => void
  onEffort: (effort: ReasoningEffort | null) => Promise<boolean>; sendButton: ReactNode
}): ReactNode {
  const provider = snapshot.providers.find(item => item.id === snapshot.activeProviderId)
  const efforts = modelEfforts(provider, snapshot.selectedModel)
  const levels: (ReasoningEffort | null)[] = [null, ...efforts]
  const [effort, setEffort] = useState<ReasoningEffort | null>(snapshot.reasoningEffort)
  useEffect(() => setEffort(snapshot.reasoningEffort), [snapshot.reasoningEffort, snapshot.selectedModel, snapshot.activeProviderId])
  const effortIndex = Math.max(0, levels.indexOf(effort))
  const contextWindow = snapshot.selectedModel ? provider?.modelDetails?.[snapshot.selectedModel]?.contextWindow : undefined
  const percent = contextWindow ? Math.min(100, usedTokens / contextWindow * 100) : undefined
  const choices = snapshot.providers.flatMap(item => item.availableModels.map(model => ({ key: JSON.stringify([item.id, model]), providerId: item.id, model })))

  /** 滑动时仅更新动画，结束后由 Store 保存；失败恢复真实快照，避免界面出现未保存的强度。 */
  async function saveEffort(index: number): Promise<void> {
    const selected = levels[index]
    if (!await onEffort(selected)) setEffort(snapshot.reasoningEffort)
  }

  return <div className="composer-tools">
    <Dropdown disabled={busy} trigger={['click']} placement="topLeft" menu={{ items: [{ key: 'add', type: 'group', label: '添加', children: [
      { key: 'file', label: '添加文件', icon: <FileOutlined /> }, { key: 'folder', label: '添加文件夹', icon: <FolderOpenOutlined /> }
    ] }], onClick: ({ key }) => { if (key === 'file' || key === 'folder') onAdd(key) } }}>
      <Button className="attachment-add" type="text" disabled={busy} icon={<PlusOutlined />} aria-label="添加附件" />
    </Dropdown>
    <div className="composer-right">
      <Dropdown disabled={busy} trigger={['click']} placement="topRight" menu={{ style: { maxHeight: 360, overflowY: 'auto' }, selectedKeys: snapshot.selectedModel ? [JSON.stringify([snapshot.activeProviderId, snapshot.selectedModel])] : [], items: [
        ...snapshot.providers.map(item => ({ key: item.id, type: 'group' as const, label: item.name, children: choices.filter(choice => choice.providerId === item.id).map(choice => ({ key: choice.key, label: choice.model })) })),
        { key: 'refresh', label: '刷新模型列表', icon: <ReloadOutlined />, disabled: !snapshot.providers.length },
        { key: 'settings', label: '配置模型服务', icon: <SettingOutlined /> }
      ], onClick: ({ key }) => {
        if (key === 'settings') onSettings()
        else if (key === 'refresh') onRefresh()
        else { const choice = choices.find(item => item.key === key); if (choice) onModel(choice.providerId, choice.model) }
      } }}>
        <Button className="model-selector" type="text" aria-label="切换模型" disabled={busy} loading={modelsLoading}><span className="model-selector-label">{snapshot.selectedModel || '选择模型'}</span><DownOutlined /></Button>
      </Dropdown>
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
      <div className="effort-control" data-level={effort || 'auto'}>
        <Slider className="effort-slider" classNames={{ rail: 'effort-rail', track: 'effort-track', handle: 'effort-handle' }} min={0} max={Math.max(1, levels.length - 1)} step={1} value={effortIndex} disabled={busy || !snapshot.config.configured || !efforts.length} ariaLabelForHandle="模型强度" ariaValueTextFormatterForHandle={value => value ? effortLabels[levels[value]!] : '自动'} tooltip={{ formatter: value => value ? effortLabels[levels[value]!] : '自动' }} onChange={index => setEffort(levels[index])} onChangeComplete={index => void saveEffort(index)} />
        <span className="effort-label">{effort ? effortLabels[effort] : '自动'}</span>
      </div>
      {sendButton}
    </div>
  </div>
}
