import { useState, type ReactNode } from 'react'
import { Alert, AutoComplete, Button, ConfigProvider, Dropdown, Empty, Form, Input, Modal, Segmented, Select, Switch, Tooltip, type SelectProps } from 'antd'
import { ApiOutlined, AppstoreOutlined, ArrowLeftOutlined, BarChartOutlined, BulbOutlined, DesktopOutlined, DownOutlined, EditOutlined, InboxOutlined, LogoutOutlined, KeyOutlined, MoonOutlined, PlusOutlined, RobotOutlined, SafetyOutlined, SettingOutlined, SunOutlined, ToolOutlined } from '@ant-design/icons'
import type { ModelApi, ProviderDraft, Snapshot, Theme } from '../../../../shared/types'
import { resolveModelApi } from '../../../../shared/model-api'
import { ModelIcon } from '../../components/ModelIcon'
import { selectionTheme } from '../../components/selection-theme'
import { defaultTypography, fontFamilies, fontSizes, type Typography } from '../../../../shared/appearance'
import { findProviderPreset, providerPresets } from './provider-presets'

const sections = [
  { key: 'models', label: '模型', icon: <RobotOutlined /> },
  { key: 'usage', label: '用量统计', icon: <BarChartOutlined /> },
  { key: 'memory', label: '记忆', icon: <BulbOutlined /> },
  { key: 'archived', label: '已归档', icon: <InboxOutlined /> },
  { key: 'appearance', label: '外观', icon: <SettingOutlined /> },
  { key: 'sandbox', label: '沙箱', icon: <SafetyOutlined /> },
  { key: 'plugins', label: '插件市场', icon: <AppstoreOutlined /> },
  { key: 'desktop', label: '电脑操控', icon: <DesktopOutlined /> },
  { key: 'skills', label: '技能', icon: <ToolOutlined /> },
  { key: 'mcp', label: 'MCP 服务器', icon: <ApiOutlined /> }
]

/** 分类设置面板；尚未接入的分类只展示占位，不修改后端状态。 */
export function ModelSettings({ snapshot, busy, onClose, onSaved, onTheme, onModel, onTypography, onRenameUser, onLogout }: {
  snapshot: Snapshot; busy: boolean; onClose: () => void; onSaved: (next: Snapshot) => void
  onTypography: (value: Typography) => void; onRenameUser: () => void; onLogout: () => void
  onTheme: (theme: Theme) => void; onModel: (providerId: string, model: string) => void
}): ReactNode {
  const [section, setSection] = useState('models')
  const [editing, setEditing] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const currentSection = sections.find(item => item.key === section)!
  const modelCount = snapshot.providers.reduce((sum, provider) => sum + provider.availableModels.length, 0)
  const modelOptions: SelectProps['options'] = snapshot.providers.map(provider => ({ label: provider.name, options: provider.availableModels.map(model => ({ value: JSON.stringify([provider.id, model]), label: model, provider: provider.name })) }))
  const user = snapshot.users.find(item => item.id === snapshot.activeUserId)!
  const typography = snapshot.typography || defaultTypography

  return <Modal open centered onCancel={onClose} footer={null} width={1020} aria-label="设置" className="settings-modal" classNames={{ container: 'settings-modal-container', body: 'settings-modal-body' }} closable={!testing} mask={{ closable: !testing }} keyboard={!testing}>
    <ConfigProvider theme={selectionTheme(snapshot.theme)}><div className="settings-layout" data-theme={snapshot.theme}>
      <aside className="settings-sidebar">
        <h2>设置</h2>
        <nav aria-label="设置分类">{[{ label: '用户设置', items: sections.slice(0, 4) }, { label: '通用设置', items: sections.slice(4) }].map(group => <div className="settings-nav-group" key={group.label} role="group" aria-label={group.label}><h3>{group.label}</h3>{group.items.map(item => <Button key={item.key} type="text" icon={item.icon} className="settings-nav-item" aria-label={item.label} aria-current={section === item.key ? 'page' : undefined} disabled={testing} onClick={() => { setSection(item.key); setEditing(null) }}>{item.label}</Button>)}</div>)}</nav>
        <div className="settings-account"><Dropdown disabled={busy || testing} trigger={['click']} placement="topLeft" menu={{ items: [
          { key: 'rename', label: '编辑名称', icon: <EditOutlined /> }, { key: 'logout', label: '退出登录', icon: <LogoutOutlined /> }
        ], onClick: ({ key }) => key === 'rename' ? onRenameUser() : onLogout() }}>
          <Button type="text" className="user-button" disabled={busy || testing} aria-label="账号菜单"><span className="avatar">{user.name.slice(0, 1)}</span><span className="user-info"><span className="user-name">{user.name}</span><span className="user-caption">{user.username}</span></span><DownOutlined /></Button>
        </Dropdown></div>
      </aside>
      <section className="settings-content" aria-label={currentSection.label}>
        {section === 'models' && editing !== null ? <ProviderEditor key={editing} id={editing} snapshot={snapshot} busy={busy} testing={testing} onTesting={setTesting} onSaved={onSaved} onBack={() => setEditing(null)} /> : <>
          <header className="settings-heading"><h2>{currentSection.label}</h2>{section === 'models' && <Button className="settings-add-provider" aria-label="添加 Provider" icon={<PlusOutlined />} disabled={busy} onClick={() => setEditing('new')}>添加 Provider</Button>}</header>
          {section === 'models' ? <>
            <p className="settings-subtitle">连接模型服务，选择适合你的模型。</p>
            <div className="settings-default-model">
              <div><strong>当前模型</strong><p>用于接下来的对话请求</p></div>
              <Select aria-label="当前模型" className="settings-model-select" variant="borderless" disabled={busy || !modelCount} placeholder="选择模型" value={snapshot.selectedModel ? JSON.stringify([snapshot.activeProviderId, snapshot.selectedModel]) : undefined} options={modelOptions} optionRender={option => <span className="model-option"><ModelIcon model={String(option.data.label)} provider={option.data.provider} /><span>{option.label}</span></span>} labelRender={({ label }) => <span className="model-option"><ModelIcon model={snapshot.selectedModel || ''} /><span>{label}</span></span>} onChange={value => { const [providerId, model] = JSON.parse(value) as [string, string]; onModel(providerId, model) }} />
            </div>
            <div className="settings-provider-heading"><h3>Provider</h3><span>{snapshot.providers.length} 个服务 · {modelCount} 个模型</span></div>
            <div className="settings-providers">{snapshot.providers.map(provider => <article className="settings-provider-card" key={provider.id}>
              <div className="settings-provider-top"><ModelIcon provider={`${provider.name} ${provider.baseUrl}`} size={40} /><div className="settings-provider-name"><h3>{provider.name}</h3><span>{resolveModelApi(provider.baseUrl, provider.api) === 'anthropic-messages' ? 'Anthropic Messages' : 'OpenAI 兼容'} · {provider.availableModels.length} 个模型</span></div><div className="settings-provider-controls"><span className="settings-provider-status">已配置</span><Tooltip title="服务开关暂未开放"><span><Switch size="small" checked disabled aria-label={`启用 ${provider.name}（暂未开放）`} /></span></Tooltip></div></div>
              <div className="settings-model-chips">{provider.availableModels.slice(0, 8).map(model => <span key={model}><ModelIcon model={model} provider={provider.name} size={16} />{model}</span>)}{provider.availableModels.length > 8 && <span className="settings-model-more">+{provider.availableModels.length - 8}</span>}</div>
              <footer className="settings-provider-footer"><span><KeyOutlined /> 凭据已保存</span><Button type="text" aria-label={`配置 ${provider.name}`} disabled={busy} onClick={() => setEditing(provider.id)}>配置 <span aria-hidden="true">↗</span></Button></footer>
            </article>)}</div>
            {!snapshot.providers.length && <Empty className="settings-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有模型服务"><Button type="primary" icon={<PlusOutlined />} disabled={busy} onClick={() => setEditing('new')}>添加第一个 Provider</Button></Empty>}
          </> : section === 'appearance' ? <>
            <div className="settings-appearance"><div><h3>主题</h3></div><Segmented value={snapshot.theme} options={[{ label: '浅色', value: 'light', icon: <SunOutlined /> }, { label: '深色', value: 'dark', icon: <MoonOutlined /> }]} disabled={busy} onChange={value => onTheme(value === 'dark' ? 'dark' : 'light')} /></div>
            <div className="settings-appearance"><h3>字体</h3><Select aria-label="字体" className="settings-font-select" value={typography.fontFamily} disabled={busy} options={Object.entries(fontFamilies).map(([value, font]) => ({ value, label: <span style={{ fontFamily: font.value }}>{font.label}</span> }))} onChange={fontFamily => onTypography({ ...typography, fontFamily })} /></div>
            <div className="settings-appearance"><h3>字号</h3><Select aria-label="字号" className="settings-font-select" value={typography.fontSize} disabled={busy} options={fontSizes.map(value => ({ value, label: `${value} px` }))} onChange={fontSize => onTypography({ ...typography, fontSize })} /></div>
            <div className="settings-font-preview" style={{ fontFamily: fontFamilies[typography.fontFamily].value, fontSize: typography.fontSize }}><span>文字预览</span><p>让想法变成现实。</p><p>The quick brown fox jumps over the lazy dog.</p></div>
          </> : <div className="settings-placeholder"><span className="settings-placeholder-icon">{currentSection.icon}</span><h3>{currentSection.label}</h3><p>暂未开放</p></div>}
        </>}
      </section>
    </div></ConfigProvider>
  </Modal>
}

/** 保留原有连通测试与保存流程，失败时不覆盖已保存的配置。 */
function ProviderEditor({ id, snapshot, busy, testing, onTesting, onSaved, onBack }: {
  id: string; snapshot: Snapshot; busy: boolean; testing: boolean; onTesting: (value: boolean) => void
  onSaved: (next: Snapshot) => void; onBack: () => void
}) {
  const [editing, setEditing] = useState(id)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [form] = Form.useForm<ProviderDraft>()
  const profile = snapshot.providers.find(provider => provider.id === editing)
  const api: ModelApi = Form.useWatch('api', form) || resolveModelApi(profile?.baseUrl || '', profile?.api)
  const baseUrl: string = Form.useWatch('baseUrl', form) || ''
  const preset = findProviderPreset(baseUrl)
  const addressOptions = providerPresets.map(item => ({
    value: item.urls[api] || item.name, disabled: !item.urls[api],
    label: <span className="provider-address-option"><ModelIcon provider={item.name} /><span><strong>{item.name}</strong><small>{item.urls[api] || '不支持此协议'}</small></span></span>
  }))

  function changeProtocol(next: ModelApi): void {
    if (!preset) return
    form.setFieldsValue({ baseUrl: preset.urls[next] || '' })
  }

  async function save(values: ProviderDraft): Promise<void> {
    if (testing || busy) return
    onTesting(true); setStatus(null)
    try {
      const result = await window.dcode.saveProvider({ ...values, apiKey: values.apiKey || '', id: editing === 'new' ? undefined : editing })
      if (result.ok) {
        onSaved(result.value)
        setEditing(result.value.activeProviderId!)
        form.setFieldsValue({ apiKey: '' })
        setStatus({ ok: true, text: '连通测试通过，配置已保存。' })
      } else setStatus({ ok: false, text: result.error })
    } catch { setStatus({ ok: false, text: '连通测试失败，请重试。' }) }
    finally { onTesting(false) }
  }

  return <>
    <Button type="text" className="settings-back" aria-label="返回模型" icon={<ArrowLeftOutlined />} disabled={testing} onClick={onBack}>返回模型</Button>
    <header className="settings-heading"><h2>{profile ? '配置 Provider' : '添加 Provider'}</h2></header>
    <p className="settings-subtitle">{profile?.name || '连接一个 OpenAI 兼容或 Anthropic 模型服务'}</p>
    <Form form={form} className="model-form" layout="vertical" initialValues={{ name: profile?.name || '', baseUrl: profile?.baseUrl || '', apiKey: '', api: resolveModelApi(profile?.baseUrl || '', profile?.api) }} disabled={testing || busy} onFinish={values => void save(values)} onValuesChange={() => setStatus(null)}>
      <div className="settings-form-row">
        <Form.Item name="name" label="配置名称" rules={[{ required: true, message: '请输入配置名称。' }]}><Input aria-label="配置名称" maxLength={40} placeholder="例如：我的模型服务" /></Form.Item>
        <Form.Item name="api" label="API 协议"><Select aria-label="API 协议" onChange={changeProtocol} options={[{ value: 'openai-completions', label: 'OpenAI 兼容' }, { value: 'anthropic-messages', label: 'Anthropic Messages' }]} /></Form.Item>
      </div>
      <Form.Item name="baseUrl" label="服务地址" rules={[{ required: true, message: '请输入服务地址。' }]}><AutoComplete options={addressOptions} popupMatchSelectWidth filterOption={false} onSelect={value => {
        const selected = findProviderPreset(value)
        if (!form.getFieldValue('name') && selected) form.setFieldsValue({ name: selected.name })
      }}><Input aria-label="服务地址" prefix={<ModelIcon provider={preset?.name || baseUrl} />} suffix={<DownOutlined />} maxLength={2048} placeholder="选择供应商或输入服务地址" /></AutoComplete></Form.Item>
      <Form.Item name="apiKey" label="API Key" rules={[{ required: editing === 'new', message: '请输入 API Key。' }]}><Input.Password aria-label="API Key" maxLength={4096} autoComplete="off" placeholder={profile ? '已保存，留空保持不变' : 'API Key'} /></Form.Item>
      {status && <Alert className="model-result" title={status.text} type={status.ok ? 'success' : 'error'} showIcon />}
      <div className="settings-form-actions"><Button disabled={testing} onClick={onBack}>取消</Button><Button type="primary" htmlType="submit" aria-label="测试并保存" loading={testing} disabled={busy}>测试并保存</Button></div>
    </Form>
  </>
}
