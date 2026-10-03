import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'

let server: Server
let baseUrl: string
let directory: string
let application: ElectronApplication
let page: Page
const requests: { model: string; max_tokens: number; messages: { role: string; content: string }[]; authorization?: string }[] = []

/** 使用隔离的数据目录启动真实 Electron，live 模式改用本地环境里的服务配置。 */
async function launch(live = false): Promise<void> {
  application = await electron.launch({ args: ['.'], env: {
    ...process.env, DCODE_USER_DATA_DIR: directory,
    ...(live ? {} : { DEEPSEEK_BASE_URL: baseUrl, DEEPSEEK_API_KEY: 'e2e-local-key', DEEPSEEK_MODEL: 'test-model' })
  } })
  page = await application.firstWindow()
}

/** 从账号界面注册或登录，验证 AuthScreen 与 preload 的认证调用链。 */
async function authenticate(username: string, register = false): Promise<void> {
  if (register) await page.getByText('注册', { exact: true }).click()
  await page.getByRole('textbox', { name: '账号', exact: true }).fill(username)
  await page.getByRole('textbox', { name: '密码', exact: true }).fill(`${username}-password`)
  if (register) await page.getByRole('textbox', { name: '确认密码', exact: true }).fill(`${username}-password`)
  await page.getByRole('button', { name: register ? '注册并登录' : '登录', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible()
}

/** 通过账号菜单退出，验证显式退出回到登录入口。 */
async function logout(): Promise<void> {
  await page.getByRole('button', { name: '账号菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: /退出登录/ }).click()
  await expect(page.getByRole('textbox', { name: '账号', exact: true })).toBeVisible()
}

test.beforeAll(async () => {
  server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const payload = JSON.parse(body)
      requests.push({ ...payload, authorization: request.headers.authorization })
      if (payload.model === 'bad-model') {
        response.writeHead(404); response.end('Model not found'); return
      }
      if (request.headers.authorization === 'Bearer invalid-key') {
        response.writeHead(401); response.end('Invalid key'); return
      }
      const prompt = payload.messages.at(-1)?.content || ''
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (payload.max_tokens === 16) {
        response.end('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        return
      }
      response.write('data: {"choices":[{"delta":{"content":"正在分析…"}}]}\n\n')
      const timer = setTimeout(() => {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '\n\n这是流式回答。\n\n```typescript\nconst answer = 42\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 流式 | 完成 |' }, finish_reason: 'stop' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
      }, prompt.includes('停止') ? 15_000 : 1_000)
      response.on('close', () => clearTimeout(timer))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

test.beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'dcode-e2e-')) })
test.afterEach(async () => {
  await application?.close().catch(() => undefined)
  rmSync(directory, { recursive: true, force: true })
})
test.afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })

test('accounts, model test/save/switch, streaming, focus, restart and logout', async () => {
  test.setTimeout(90_000)
  await launch()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await expect(page.getByRole('textbox', { name: '账号', exact: true })).toBeVisible()
  expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined')
  expect(await page.evaluate(() => window.dcode.send({ content: 'unauthenticated' }))).toMatchObject({ ok: false })
  expect(await page.evaluate(() => window.dcode.getState())).toMatchObject({ ok: true, value: { users: [], conversations: [], models: [] } })
  await authenticate('alice', true)
  await expect(page.getByRole('heading', { name: '今天想写点什么？' })).toBeVisible()
  expect(await page.evaluate(async () => JSON.stringify(await window.dcode.getState()))).not.toContain('e2e-local-key')

  const composer = page.getByRole('textbox', { name: '消息', exact: true })
  await composer.click()
  expect(await composer.evaluate(element => ({ outline: getComputedStyle(element).outlineStyle, shadow: getComputedStyle(element).boxShadow }))).toEqual({ outline: 'none', shadow: 'none' })
  await page.getByRole('button', { name: '模型加速说明', exact: true }).click()
  await expect(page.getByRole('tooltip')).toHaveText('仅对支持加速的模型生效')
  await composer.click()

  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('textbox', { name: '配置名称', exact: true }).fill('模型 A')
  await page.getByRole('textbox', { name: '模型 ID', exact: true }).fill('model-a')
  await page.getByRole('button', { name: '测试并保存', exact: true }).click()
  await expect(page.getByText('连通测试通过，配置已保存。', { exact: true })).toBeVisible()
  expect(requests.at(-1)).toMatchObject({ model: 'model-a', max_tokens: 16, authorization: 'Bearer e2e-local-key' })

  await page.getByRole('combobox', { name: '编辑模型配置', exact: true }).click()
  await page.getByText('添加模型', { exact: true }).click()
  await page.getByRole('textbox', { name: '配置名称', exact: true }).fill('模型 B')
  await page.getByRole('textbox', { name: '服务地址', exact: true }).fill(baseUrl)
  await page.getByRole('textbox', { name: 'API Key', exact: true }).fill('e2e-second-key')
  await page.getByRole('textbox', { name: '模型 ID', exact: true }).fill('model-b')
  await page.getByRole('button', { name: '测试并保存', exact: true }).click()
  await expect(page.getByText('连通测试通过，配置已保存。', { exact: true })).toBeVisible()
  const savedModels = await page.evaluate(() => window.dcode.getState())
  await page.getByRole('textbox', { name: '模型 ID', exact: true }).fill('bad-model')
  await page.getByRole('button', { name: '测试并保存', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('连通测试未通过')
  expect(await page.evaluate(() => window.dcode.getState())).toEqual(savedModels)
  await page.getByRole('textbox', { name: '模型 ID', exact: true }).fill('model-b')
  await page.getByRole('textbox', { name: 'API Key', exact: true }).fill('invalid-key')
  await page.getByRole('button', { name: '测试并保存', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('连通测试未通过')
  expect(await page.evaluate(() => window.dcode.getState())).toEqual(savedModels)
  await page.getByRole('button', { name: '关闭', exact: true }).click()

  await page.getByRole('button', { name: '切换模型', exact: true }).click()
  await page.getByRole('menuitem', { name: '模型 A · model-a', exact: true }).click()
  await expect(page.getByRole('button', { name: '切换模型', exact: true })).toContainText('model-a')
  await page.getByRole('button', { name: '实现一个功能' }).click()
  await expect(composer).toHaveValue(/梳理需求/)
  await composer.fill('实现一个 TypeScript 函数')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByText('正在分析…', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toBeDisabled()
  await expect(page.locator('article[data-status="complete"][data-role="assistant"]')).toHaveCount(1)
  expect(requests.at(-1)).toMatchObject({ model: 'model-a', authorization: 'Bearer e2e-local-key' })
  await expect(page.locator('pre')).toContainText('const answer = 42')
  await expect(page.locator('table')).toContainText('流式')
  await page.getByRole('button', { name: '复制代码', exact: true }).click()
  await expect(page.getByText('已复制', { exact: true })).toBeVisible()
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('const answer = 42')

  await composer.fill('请停止这次生成')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.locator('article[data-status="streaming"]')).toContainText('正在分析…')
  await page.getByRole('button', { name: '停止生成', exact: true }).click()
  await expect(page.getByText('已停止生成', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '重新生成', exact: true }).click()
  await expect(page.locator('article[data-status="streaming"]')).toContainText('正在分析…')
  expect(requests.at(-1)?.messages.filter(m => m.role === 'user')).toHaveLength(2)
  expect(requests.at(-1)?.messages.at(-2)?.role).toBe('assistant')
  await page.getByRole('button', { name: '停止生成', exact: true }).click()

  await page.getByRole('button', { name: '管理对话 实现一个 TypeScript 函数', exact: true }).click()
  await page.getByRole('menuitem', { name: /重命名/ }).click()
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('函数讨论')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('textbox', { name: '搜索对话', exact: true }).fill('不存在')
  await expect(page.getByText('没有找到对话', { exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '搜索对话', exact: true }).fill('')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByText('深色', { exact: true }).click()
  await expect(page.locator('.shell')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await application.close()
  await launch()
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible()
  await expect(page.locator('.shell')).toHaveAttribute('data-theme', 'dark')
  await expect(page.getByRole('button', { name: '函数讨论', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '切换模型', exact: true })).toContainText('model-a')
  await expect(page.getByText('已停止生成', { exact: true })).toBeVisible()
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(820, 620))
  expect(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth)).toBe(true)
  const persisted = readFileSync(join(directory, 'state.json'), 'utf8')
  for (const secret of ['alice-password', 'e2e-local-key', 'e2e-second-key']) expect(persisted).not.toContain(secret)

  const aliceState = await page.evaluate(() => window.dcode.getState())
  await logout()
  await application.close()
  await launch()
  await expect(page.getByRole('textbox', { name: '账号', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '账号', exact: true }).fill('alice')
  await page.getByRole('textbox', { name: '密码', exact: true }).fill('wrong-password')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('账号或密码不正确')
  await authenticate('alice')
  await expect(page.getByRole('button', { name: '函数讨论', exact: true })).toBeVisible()
  await logout()
  await authenticate('bob', true)
  await expect(page.getByText('暂无对话', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.dcode.getState())).toMatchObject({ ok: true, value: { models: [], conversations: [], theme: 'light' } })
  if (!aliceState.ok) throw new Error('Missing Alice snapshot')
  expect(await page.evaluate(id => window.dcode.action({ type: 'model:select', id }), aliceState.value.models[0].id)).toMatchObject({ ok: false })
  expect(await page.evaluate(id => window.dcode.action({ type: 'conversation:select', id }), aliceState.value.conversations[0].id)).toMatchObject({ ok: false })
  await logout()
  await authenticate('alice')
  await page.getByRole('button', { name: '管理对话 函数讨论', exact: true }).click()
  await page.getByRole('menuitem', { name: /删除/ }).click()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByText('暂无对话', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('live DeepSeek model test and streaming smoke', async () => {
  test.skip(process.env.DCODE_LIVE_TEST !== '1', 'Opt-in real provider request')
  test.setTimeout(90_000)
  await launch(true)
  await authenticate('live-smoke', true)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '测试并保存', exact: true }).click()
  await expect(page.getByText('连通测试通过，配置已保存。', { exact: true })).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('这是连接测试。请仅回答：连接成功')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.locator('article[data-status="complete"][data-role="assistant"]')).toContainText('连接成功', { timeout: 60_000 })
})
