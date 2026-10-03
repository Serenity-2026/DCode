import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'

let server: Server
let baseUrl: string
let directory: string
let application: ElectronApplication
let page: Page
let failDiscovery = false
const discoveries: { path: string; authorization?: string }[] = []
const requests: { model: string; max_tokens: number; service_tier?: string; reasoning_effort?: string; messages: { role: string; content: string }[]; authorization?: string }[] = []

/** 使用隔离的数据目录启动真实 Electron，live 模式改用本地环境里的服务配置。 */
async function launch(live = false): Promise<void> {
  application = await electron.launch({ args: ['.'], env: {
    ...process.env, DCODE_USER_DATA_DIR: directory,
    ...(live ? {} : { DEEPSEEK_BASE_URL: baseUrl, DEEPSEEK_API_KEY: 'e2e-local-key' })
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
  await expect(page.getByRole('button', { name: '切换模型', exact: true })).toBeEnabled()
}

/** 通过账号菜单退出，验证显式退出回到登录入口。 */
async function logout(): Promise<void> {
  await page.getByRole('button', { name: '账号菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: /退出登录/ }).click()
  await expect(page.getByRole('textbox', { name: '账号', exact: true })).toBeVisible()
}

test.beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.method === 'GET') {
      discoveries.push({ path: request.url || '', authorization: request.headers.authorization })
      if (failDiscovery || request.headers.authorization === 'Bearer invalid-key') {
        response.writeHead(401); response.end('Invalid key'); return
      }
      if (request.url === '/missing/models') {
        response.writeHead(404); response.end('Not found'); return
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      const ids = request.headers.authorization === 'Bearer e2e-second-key' ? ['other-fast-model', 'other-chat'] : ['gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol']
      response.end(JSON.stringify({ data: ids.map(id => ({ id, object: 'model', ...(id === 'gpt-6-astra' || id === 'gpt-6-sol' ? { context_window: id === 'gpt-6-astra' ? 4096 : 8192, effort: { supported_levels: ['low', 'medium', 'high'] } } : {}) })) })); return
    }
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const payload = JSON.parse(body)
      requests.push({ ...payload, authorization: request.headers.authorization })
      if (request.headers.authorization === 'Bearer invalid-key') {
        response.writeHead(401); response.end('Invalid key'); return
      }
      const prompt = payload.messages.at(-1)?.content || ''
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
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

test.beforeEach(() => { failDiscovery = false; discoveries.length = 0; requests.length = 0; directory = mkdtempSync(join(tmpdir(), 'dcode-e2e-')) })
test.afterEach(async () => {
  await application?.close().catch(() => undefined)
  rmSync(directory, { recursive: true, force: true })
})
test.afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })

test('accounts, model discovery/switch, fast mode, streaming and restart', async () => {
  test.setTimeout(90_000)
  await launch()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await expect(page.getByRole('textbox', { name: '账号', exact: true })).toBeVisible()
  expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined')
  expect(await page.evaluate(() => window.dcode.send({ content: 'unauthenticated' }))).toMatchObject({ ok: false })
  expect(await page.evaluate(() => window.dcode.getState())).toMatchObject({ ok: true, value: { users: [], conversations: [], providers: [] } })
  await authenticate('alice', true)
  await expect(page.getByRole('heading', { name: '今天想写点什么？' })).toBeVisible()
  expect(await page.evaluate(async () => JSON.stringify(await window.dcode.getState()))).not.toContain('e2e-local-key')

  const composer = page.getByRole('textbox', { name: '消息', exact: true })
  await composer.click()
  expect(await composer.evaluate(element => ({ outline: getComputedStyle(element).outlineStyle, shadow: getComputedStyle(element).boxShadow }))).toEqual({ outline: 'none', shadow: 'none' })
  const speed = page.getByRole('button', { name: '快速模式', exact: true })
  await expect(speed).toHaveAttribute('aria-pressed', 'false')
  const outlined = await speed.locator('svg').evaluate(element => element.innerHTML)
  await speed.click()
  await expect(speed).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => speed.evaluate(element => getComputedStyle(element).color)).toBe('rgb(22, 119, 255)')
  expect(await speed.locator('svg').evaluate(element => element.innerHTML)).not.toBe(outlined)
  await expect(page.getByRole('tooltip')).toContainText('仅对支持加速的模型生效')
  await composer.click()

  await page.getByRole('button', { name: '切换模型', exact: true }).click()
  for (const model of ['gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol']) await expect(page.getByRole('menuitem', { name: model, exact: true })).toBeVisible()
  await page.getByRole('menuitem', { name: /配置模型服务/ }).click()
  await expect(page.getByRole('textbox', { name: '模型 ID', exact: true })).toHaveCount(0)
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(820, 620))
  await expect.poll(() => page.getByRole('button', { name: '测试并保存', exact: true }).evaluate(element => element.getBoundingClientRect().bottom <= innerHeight)).toBe(true)
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 820))
  await page.getByRole('textbox', { name: '配置名称', exact: true }).fill('服务 A')
  await page.getByRole('button', { name: '测试并保存', exact: true }).click()
  await expect(page.getByText('连通测试通过，配置已保存。', { exact: true })).toBeVisible()
  expect(discoveries.at(-1)).toMatchObject({ path: '/models', authorization: 'Bearer e2e-local-key' })
  expect(requests).toHaveLength(0)

  await page.getByRole('combobox', { name: '编辑服务配置', exact: true }).click()
  await page.getByText('添加服务', { exact: true }).click()
  await page.getByRole('textbox', { name: '配置名称', exact: true }).fill('服务 B')
  await page.getByRole('textbox', { name: '服务地址', exact: true }).fill(`${baseUrl}/secondary`)
  await page.getByRole('textbox', { name: 'API Key', exact: true }).fill('e2e-second-key')
  await page.getByRole('button', { name: '测试并保存', exact: true }).click()
  await expect(page.getByText('连通测试通过，配置已保存。', { exact: true })).toBeVisible()
  const savedModels = await page.evaluate(() => window.dcode.getState())
  await page.getByRole('textbox', { name: '服务地址', exact: true }).fill(`${baseUrl}/missing`)
  await page.getByRole('button', { name: '测试并保存', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('连通测试未通过')
  expect(await page.evaluate(() => window.dcode.getState())).toEqual(savedModels)
  await page.getByRole('textbox', { name: '服务地址', exact: true }).fill(`${baseUrl}/secondary`)
  await page.getByRole('textbox', { name: 'API Key', exact: true }).fill('invalid-key')
  await page.getByRole('button', { name: '测试并保存', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('连通测试未通过')
  expect(await page.evaluate(() => window.dcode.getState())).toEqual(savedModels)
  await page.getByRole('button', { name: '关闭', exact: true }).click()

  await page.getByRole('button', { name: '切换模型', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'other-fast-model', exact: true })).toBeVisible()
  await page.getByRole('menuitem', { name: 'gpt-6-sol', exact: true }).click()
  await expect(page.getByRole('button', { name: '切换模型', exact: true })).toContainText('gpt-6-sol')
  const beforeFailure = await page.evaluate(() => window.dcode.getState())
  failDiscovery = true
  await page.getByRole('button', { name: '切换模型', exact: true }).click()
  await page.getByRole('menuitem', { name: /刷新模型列表/ }).click()
  await expect(page.getByText(/服务 A：API 密钥无效/)).toBeVisible()
  await expect(page.getByRole('button', { name: '切换模型', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => window.dcode.getState())).toEqual(beforeFailure)
  failDiscovery = false
  await page.getByRole('button', { name: '实现一个功能' }).click()
  await expect(composer).toHaveValue(/梳理需求/)
  await composer.fill('实现一个 TypeScript 函数')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByText('正在分析…', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toBeDisabled()
  await expect(page.locator('article[data-status="complete"][data-role="assistant"]')).toHaveCount(1)
  expect(requests.at(-1)).toMatchObject({ model: 'gpt-6-sol', authorization: 'Bearer e2e-local-key', service_tier: 'priority' })
  await expect(page.locator('pre')).toContainText('const answer = 42')
  await expect(page.locator('table')).toContainText('流式')
  await page.getByRole('button', { name: '复制代码', exact: true }).click()
  await expect(page.getByText('已复制', { exact: true })).toBeVisible()
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('const answer = 42')

  await speed.click()
  await expect(speed).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(() => speed.evaluate(element => getComputedStyle(element).color)).not.toBe('rgb(22, 119, 255)')
  expect(await speed.locator('svg').evaluate(element => element.innerHTML)).toBe(outlined)
  await composer.fill('请停止这次生成')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.locator('article[data-status="streaming"]')).toContainText('正在分析…')
  expect(requests.at(-1)).not.toHaveProperty('service_tier')
  await page.getByRole('button', { name: '停止生成', exact: true }).click()
  await expect(page.getByText('已停止生成', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '重新生成', exact: true }).click()
  await expect(page.locator('article[data-status="streaming"]')).toContainText('正在分析…')
  expect(requests.at(-1)?.messages.filter(m => m.role === 'user')).toHaveLength(2)
  expect(requests.at(-1)?.messages.at(-2)?.role).toBe('assistant')
  await page.getByRole('button', { name: '停止生成', exact: true }).click()

  await speed.click()
  await expect(speed).toHaveAttribute('aria-pressed', 'true')
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
  await expect(page.getByRole('button', { name: '切换模型', exact: true })).toContainText('gpt-6-sol')
  await expect(page.getByText('已停止生成', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '快速模式', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: '切换模型', exact: true })).toBeEnabled()
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
  expect(await page.evaluate(() => window.dcode.getState())).toMatchObject({ ok: true, value: { providers: [], conversations: [], theme: 'light', fastMode: false } })
  if (!aliceState.ok) throw new Error('Missing Alice snapshot')
  expect(await page.evaluate(providerId => window.dcode.action({ type: 'model:select', providerId, model: 'gpt-6-sol' }), aliceState.value.providers[0].id)).toMatchObject({ ok: false })
  expect(await page.evaluate(id => window.dcode.action({ type: 'conversation:select', id }), aliceState.value.conversations[0].id)).toMatchObject({ ok: false })
  await logout()
  await authenticate('alice')
  await page.getByRole('button', { name: '管理对话 函数讨论', exact: true }).click()
  await page.getByRole('menuitem', { name: /删除/ }).click()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByText('暂无对话', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('composer attachments, context meter, reasoning strength and responsive toolbar', async () => {
  test.setTimeout(60_000)
  await launch()
  expect(await page.evaluate(() => window.dcode.selectAttachments('file'))).toMatchObject({ ok: false })
  await authenticate('tools', true)
  const input = page.getByRole('textbox', { name: '消息', exact: true })
  const context = page.getByRole('button', { name: '上下文用量', exact: true })
  const strength = page.getByRole('slider', { name: '模型强度', exact: true })
  const add = page.getByRole('button', { name: '添加附件', exact: true })
  await expect(context).toHaveAttribute('data-limit', '4096')
  const originalTokens = Number(await context.getAttribute('data-used'))
  await input.fill('中'.repeat(2200))
  expect(Number(await context.getAttribute('data-used'))).toBeGreaterThan(originalTokens + 2000)
  expect(Number(await context.getAttribute('data-percent'))).toBeGreaterThan(50)
  await context.hover()
  await expect(page.getByRole('tooltip')).toContainText('窗口：4,096 tokens')
  await expect(page.getByRole('tooltip')).toContainText('剩余约')
  await expect(page.getByRole('tooltip')).toContainText('预估')
  await input.fill('请查看附件代码')
  await strength.focus()
  await strength.press('ArrowRight')
  await expect(strength).toHaveAttribute('aria-valuetext', '轻量')
  await expect(page.getByRole('button', { name: '切换模型', exact: true })).toBeEnabled()
  await strength.press('ArrowRight')
  await expect(strength).toHaveAttribute('aria-valuetext', '标准')
  await expect.poll(async () => {
    const state = await page.evaluate(() => window.dcode.getState()); return state.ok ? state.value.reasoningEffort : undefined
  }).toBe('medium')
  const source = join(directory, 'selected.ts')
  const project = join(directory, 'sample-project')
  mkdirSync(project)
  writeFileSync(source, 'export const selected = "attachment-e2e"')
  writeFileSync(join(project, 'folder.ts'), 'export const folder = "folder-e2e"')
  writeFileSync(join(project, '.env'), 'excluded-file')
  await application.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async (...args: unknown[]) => {
      const options = args.at(-1) as Electron.OpenDialogOptions
      const global = globalThis as unknown as { dialogOptions?: Electron.OpenDialogOptions }
      global.dialogOptions = options
      return { canceled: false, filePaths: options.properties?.includes('openDirectory') ? [paths.project] : [paths.source] }
    }
  }, { source, project })
  await add.click()
  await page.getByRole('menuitem', { name: /添加文件$/, exact: false }).click()
  await expect(page.getByRole('button', { name: '移除附件 selected.ts', exact: true })).toBeVisible()
  expect(await application.evaluate(() => (globalThis as unknown as { dialogOptions?: Electron.OpenDialogOptions }).dialogOptions?.properties)).toEqual(['openFile', 'multiSelections'])
  const withFile = Number(await context.getAttribute('data-used'))
  await page.getByRole('button', { name: '移除附件 selected.ts', exact: true }).click()
  expect(Number(await context.getAttribute('data-used'))).toBeLessThan(withFile)
  await add.click(); await page.getByRole('menuitem', { name: /添加文件$/, exact: false }).click()
  await add.click(); await page.getByRole('menuitem', { name: /添加文件夹/ }).click()
  await expect(page.getByRole('button', { name: '移除附件 sample-project', exact: true })).toBeVisible()
  await expect(page.getByText(/已跳过 1 项/)).toBeVisible()
  expect(await application.evaluate(() => (globalThis as unknown as { dialogOptions?: Electron.OpenDialogOptions }).dialogOptions?.properties)).toEqual(['openDirectory'])
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(820, 620))
  expect(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth)).toBe(true)
  const plusBounds = await add.boundingBox()
  const modelBounds = await page.getByRole('button', { name: '切换模型', exact: true }).boundingBox()
  expect(modelBounds!.x).toBeGreaterThan(plusBounds!.x + plusBounds!.width)
  for (const control of [context, strength, page.getByRole('button', { name: '快速模式', exact: true })]) {
    const bounds = await control.boundingBox(); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(820)
  }
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.locator('article[data-role="assistant"][data-status="complete"]')).toHaveCount(1)
  expect(requests.at(-1)?.reasoning_effort).toBe('medium')
  expect(requests.at(-1)?.messages.at(-1)?.content).toContain('attachment-e2e')
  expect(requests.at(-1)?.messages.at(-1)?.content).toContain('folder-e2e')
  expect(requests.at(-1)?.messages.at(-1)?.content).not.toContain('excluded-file')
  await expect(page.getByRole('button', { name: /移除附件/ })).toHaveCount(0)
  await expect(page.locator('article[data-role="user"]')).toContainText('sample-project')
  await page.getByRole('button', { name: '重新生成', exact: true }).click()
  await expect(page.locator('article[data-role="assistant"][data-status="complete"]')).toHaveCount(1)
  expect(requests.at(-1)?.messages.at(-1)?.content).toContain('attachment-e2e')
  await page.getByRole('button', { name: '切换模型', exact: true }).click()
  await page.getByRole('menuitem', { name: 'gpt-5.6-sol', exact: true }).click()
  await expect(context).toHaveAttribute('data-limit', 'unknown')
  await context.hover()
  await expect(page.getByRole('tooltip')).toContainText('窗口：未知')
  await input.click()
  await application.close(); await launch()
  await expect(page.getByRole('button', { name: '切换模型', exact: true })).toBeEnabled()
  await expect(page.getByRole('slider', { name: '模型强度', exact: true })).toHaveAttribute('aria-valuetext', '标准')
  await expect(page.locator('article[data-role="user"]')).toContainText('sample-project')
  await page.getByRole('button', { name: '新对话', exact: true }).click()
  const resumedInput = page.getByRole('textbox', { name: '消息', exact: true })
  await resumedInput.fill('取消后保留的草稿')
  await application.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }) })
  await page.getByRole('button', { name: '添加附件', exact: true }).click(); await page.getByRole('menuitem', { name: /添加文件$/ }).click()
  await expect(resumedInput).toHaveValue('取消后保留的草稿')
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
