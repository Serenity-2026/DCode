import { useState, type ReactNode } from 'react'
import { Alert, Button, Form, Input, Segmented, Select } from 'antd'
import { BrandMark } from './BrandMark'
import type { AuthInput, Snapshot } from '../../shared/types'

/** 登录/注册入口，依赖 Ant Design 表单和 preload 的 Auth API；成功后把账号快照交给 Root。 */
export function AuthScreen({ snapshot, onLogin }: { snapshot: Snapshot; onLogin: (next: Snapshot) => void }): ReactNode {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [form] = Form.useForm<AuthInput & { confirmPassword: string }>()

  /** 仅将账号与密码交给主进程校验，成功后组件卸载，不在界面保存密码或登录令牌。 */
  async function submit(values: AuthInput): Promise<void> {
    if (busy) return
    setBusy(true); setError('')
    try {
      const result = await (mode === 'login' ? window.dcode.login(values) : window.dcode.register(values))
      if (result.ok) onLogin(result.value)
      else setError(result.error)
    } catch { setError('登录服务连接失败，请重试。') }
    finally { setBusy(false) }
  }

  return <main className="auth-screen"><div className="auth-titlebar" /><section className="auth-card">
    <div className="auth-brand"><span className="brand-mark"><BrandMark /></span>DCode</div>
    <Segmented block options={[{ label: '登录', value: 'login' }, { label: '注册', value: 'register' }]} value={mode} disabled={busy} onChange={value => {
      setMode(value === 'register' ? 'register' : 'login'); setError(''); form.resetFields()
    }} />
    <Form className="auth-form" form={form} layout="vertical" disabled={busy} onFinish={values => void submit(values)}>
      <Form.Item name="username" label="账号" rules={[{ required: true, message: '请输入账号。' }]}><Input aria-label="账号" autoComplete="username" maxLength={32} placeholder="账号" /></Form.Item>
      <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码。' }, { min: 8, max: 128, message: '密码需为 8–128 个字符。' }]}><Input.Password aria-label="密码" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} maxLength={128} placeholder="密码" /></Form.Item>
      {mode === 'register' && <>
        <Form.Item name="confirmPassword" label="确认密码" dependencies={['password']} rules={[{ required: true, message: '请确认密码。' }, ({ getFieldValue }) => ({ validator: async (_rule, value) => {
          if (value && value !== getFieldValue('password')) throw new Error('两次输入的密码不一致。')
        } })]}><Input.Password aria-label="确认密码" autoComplete="new-password" maxLength={128} placeholder="再次输入密码" /></Form.Item>
        {snapshot.legacyUsers.length > 0 && <Form.Item name="legacyUserId" label="关联旧档案"><Select aria-label="关联旧档案" placeholder="新建账号" allowClear options={snapshot.legacyUsers.map(u => ({ label: u.name, value: u.id }))} /></Form.Item>}
      </>}
      {error && <Alert className="auth-error" title={error} type="error" showIcon />}
      <Button block type="primary" htmlType="submit" loading={busy}>{mode === 'login' ? '登录' : '注册并登录'}</Button>
    </Form>
  </section></main>
}
