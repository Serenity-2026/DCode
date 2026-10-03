import { useState, type ReactNode } from 'react'
import { Alert, Button, Form, Input, Modal, Segmented, Select } from 'antd'
import type { ModelDraft, Snapshot, Theme } from '../../shared/types'

/** 账号模型编辑器，依赖 preload Models API 实测配置后保存，主题操作仍由 Workspace.act 处理。 */
export function ModelSettings({ snapshot, busy, onClose, onSaved, onTheme }: {
  snapshot: Snapshot; busy: boolean; onClose: () => void; onSaved: (next: Snapshot) => void; onTheme: (theme: Theme) => void
}): ReactNode {
  const [editing, setEditing] = useState(snapshot.activeModelId || 'new')
  const [testing, setTesting] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [form] = Form.useForm<ModelDraft>()
  const profile = snapshot.models.find(m => m.id === editing)

  /** 提交当前表单，主进程校验归属并测试；仅成功结果更新账号快照，失败保留原模型选择。 */
  async function save(values: ModelDraft): Promise<void> {
    if (testing || busy) return
    setTesting(true); setStatus(null)
    try {
      const result = await window.dcode.saveModel({ ...values, apiKey: values.apiKey || '', id: editing === 'new' ? undefined : editing })
      if (result.ok) {
        onSaved(result.value)
        setEditing(result.value.activeModelId!)
        form.setFieldsValue({ apiKey: '' })
        setStatus({ ok: true, text: '连通测试通过，配置已保存。' })
      } else setStatus({ ok: false, text: result.error })
    } catch { setStatus({ ok: false, text: '连通测试失败，请重试。' }) }
    finally { setTesting(false) }
  }

  return <Modal title="设置" open onCancel={onClose} footer={null} width={500} closable={!testing} mask={{ closable: !testing }} keyboard={!testing}>
    <div className="settings-section"><span className="settings-label">外观</span><Segmented block value={snapshot.theme} options={[{ label: '浅色', value: 'light' }, { label: '深色', value: 'dark' }]} disabled={busy || testing} onChange={value => onTheme(value === 'dark' ? 'dark' : 'light')} /></div>
    <div className="settings-section"><span className="settings-label">模型配置</span>
      <Select className="model-editor-select" aria-label="编辑模型配置" disabled={testing || busy} value={editing} options={[...snapshot.models.map(m => ({ label: `${m.name} · ${m.model}`, value: m.id })), { label: '添加模型', value: 'new' }]} onChange={id => {
        setEditing(id); setStatus(null)
        const model = snapshot.models.find(m => m.id === id)
        form.setFieldsValue({ name: model?.name || '', baseUrl: model?.baseUrl || '', model: model?.model || '', apiKey: '' })
      }} />
      <Form form={form} className="model-form" layout="vertical" initialValues={{ name: profile?.name || '', baseUrl: profile?.baseUrl || '', model: profile?.model || '', apiKey: '' }} disabled={testing || busy} onFinish={values => void save(values)} onValuesChange={() => setStatus(null)}>
        <Form.Item name="name" label="配置名称" rules={[{ required: true, message: '请输入配置名称。' }]}><Input aria-label="配置名称" maxLength={40} placeholder="例如：日常编程" /></Form.Item>
        <Form.Item name="baseUrl" label="服务地址" rules={[{ required: true, message: '请输入服务地址。' }]}><Input aria-label="服务地址" maxLength={2048} placeholder="https://api.example.com/v1" /></Form.Item>
        <Form.Item name="apiKey" label="API Key" rules={[{ required: editing === 'new', message: '请输入 API Key。' }]}><Input.Password aria-label="API Key" maxLength={4096} autoComplete="off" placeholder={profile ? '已保存，留空保持不变' : 'API Key'} /></Form.Item>
        <Form.Item name="model" label="模型 ID" rules={[{ required: true, message: '请输入模型 ID。' }]}><Input aria-label="模型 ID" maxLength={120} placeholder="服务支持的模型 ID" /></Form.Item>
        {status && <Alert className="model-result" title={status.text} type={status.ok ? 'success' : 'error'} showIcon />}
        <Button type="primary" block htmlType="submit" loading={testing} disabled={busy}>测试并保存</Button>
      </Form>
    </div>
  </Modal>
}
