import { useState, type ReactNode } from 'react'
import { Alert, Button, Form, Input, Modal, Segmented, Select } from 'antd'
import type { ProviderDraft, Snapshot, Theme } from '../../../../shared/types'
import { resolveModelApi } from '../../../../shared/model-api'

/** 账号服务编辑器，依赖 preload Models API 读取模型列表后保存，主题操作仍由 Workspace.act 处理。 */
export function ModelSettings({ snapshot, busy, onClose, onSaved, onTheme }: {
  snapshot: Snapshot; busy: boolean; onClose: () => void; onSaved: (next: Snapshot) => void; onTheme: (theme: Theme) => void
}): ReactNode {
  const [editing, setEditing] = useState(snapshot.activeProviderId || 'new')
  const [testing, setTesting] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [form] = Form.useForm<ProviderDraft>()
  const profile = snapshot.providers.find(m => m.id === editing)

  /** 提交当前表单，主进程校验归属并测试；仅成功结果更新账号快照，失败保留原服务和模型选择。 */
  async function save(values: ProviderDraft): Promise<void> {
    if (testing || busy) return
    setTesting(true); setStatus(null)
    try {
      const result = await window.dcode.saveProvider({ ...values, apiKey: values.apiKey || '', id: editing === 'new' ? undefined : editing })
      if (result.ok) {
        onSaved(result.value)
        setEditing(result.value.activeProviderId!)
        form.setFieldsValue({ apiKey: '' })
        setStatus({ ok: true, text: '连通测试通过，配置已保存。' })
      } else setStatus({ ok: false, text: result.error })
    } catch { setStatus({ ok: false, text: '连通测试失败，请重试。' }) }
    finally { setTesting(false) }
  }

  return <Modal title="设置" open centered onCancel={onClose} footer={null} width={500} closable={!testing} mask={{ closable: !testing }} keyboard={!testing}>
    <div className="settings-section"><span className="settings-label">外观</span><Segmented block value={snapshot.theme} options={[{ label: '浅色', value: 'light' }, { label: '深色', value: 'dark' }]} disabled={busy || testing} onChange={value => onTheme(value === 'dark' ? 'dark' : 'light')} /></div>
    <div className="settings-section"><span className="settings-label">服务配置</span>
      <Select className="model-editor-select" aria-label="编辑服务配置" disabled={testing || busy} value={editing} options={[...snapshot.providers.map(m => ({ label: m.name, value: m.id })), { label: '添加服务', value: 'new' }]} onChange={id => {
        setEditing(id); setStatus(null)
        const model = snapshot.providers.find(m => m.id === id)
        form.setFieldsValue({ name: model?.name || '', baseUrl: model?.baseUrl || '', apiKey: '', api: resolveModelApi(model?.baseUrl || '', model?.api) })
      }} />
      <Form form={form} className="model-form" layout="vertical" initialValues={{ name: profile?.name || '', baseUrl: profile?.baseUrl || '', apiKey: '', api: resolveModelApi(profile?.baseUrl || '', profile?.api) }} disabled={testing || busy} onFinish={values => void save(values)} onValuesChange={() => setStatus(null)}>
        <Form.Item name="name" label="配置名称" rules={[{ required: true, message: '请输入配置名称。' }]}><Input aria-label="配置名称" maxLength={40} placeholder="例如：我的模型服务" /></Form.Item>
        <Form.Item name="baseUrl" label="服务地址" rules={[{ required: true, message: '请输入服务地址。' }]}><Input aria-label="服务地址" maxLength={2048} placeholder="https://api.example.com/v1" /></Form.Item>
        <Form.Item name="api" label="API 协议"><Select aria-label="API 协议" options={[{ value: 'openai-completions', label: 'OpenAI 兼容' }, { value: 'anthropic-messages', label: 'Anthropic Messages' }]} /></Form.Item>
        <Form.Item name="apiKey" label="API Key" rules={[{ required: editing === 'new', message: '请输入 API Key。' }]}><Input.Password aria-label="API Key" maxLength={4096} autoComplete="off" placeholder={profile ? '已保存，留空保持不变' : 'API Key'} /></Form.Item>
        {status && <Alert className="model-result" title={status.text} type={status.ok ? 'success' : 'error'} showIcon />}
        <Button type="primary" block htmlType="submit" loading={testing} disabled={busy}>测试并保存</Button>
      </Form>
    </div>
  </Modal>
}
