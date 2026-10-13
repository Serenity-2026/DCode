import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { anthropicEvents, openAIResponse, testCall } from '../unit/llm-fixtures'

let server: Server
let baseUrl: string
let directory: string
let application: ElectronApplication
let page: Page
let failDiscovery = false
const discoveries: { path: string; authorization?: string }[] = []
const requests: { model: string; max_tokens: number; service_tier?: string; reasoning_effort?: string; messages: { role: string; content: string }[]; authorization?: string }[] = []
const nativeRequests: { system: string; model: string; messages: { role: string; content: { type: string; tool_use_id?: string; is_error?: boolean }[] }[] }[] = []

/** 使用隔离的数据目录启动真实 Electron，live 模式改用本地环境里的服务配置。 */
async function launch(live = false): Promise<void> {
  application = await electron.launch({ args: ['.'], env: {
    ...process.env, DCODE_USER_DATA_DIR: directory,
    ...(live ? {} : { BASE_URL: baseUrl, API_KEY: 'e2e-local-key' })
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

/** 检查真实菜单文字与背景的 WCAG 对比度，依赖 Page 和浏览器计算样式，覆盖选中与悬浮状态。 */
async function verifyModelMenu(selectedModel: string): Promise<void> {
  const trigger = page.getByRole('button', { name: '切换模型', exact: true })
  await expect(trigger.getByRole('img', { name: 'up', exact: true })).toBeVisible()
  const menu = page.getByRole('menu')
  await expect.poll(async () => {
    const popup = await menu.boundingBox()
    const button = await trigger.boundingBox()
    return Boolean(popup && button && popup.y + popup.height <= button.y)
  }).toBe(true)
  for (const model of [selectedModel, 'gpt-5.6-sol']) {
    const item = page.getByRole('menuitem', { name: model, exact: true })
    for (const hover of [false, true]) {
      if (hover) await item.hover()
      await expect.poll(() => item.evaluate(element => {
        const luminance = (color: string): number => {
          const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(value => {
            const channel = Number(value) / 255
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
          })
          return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
        }
        let background = element
        while (getComputedStyle(background).backgroundColor === 'rgba(0, 0, 0, 0)' && background.parentElement) background = background.parentElement
        const text = luminance(getComputedStyle(element).color)
        const surface = luminance(getComputedStyle(background).backgroundColor)
        return (Math.max(text, surface) + 0.05) / (Math.min(text, surface) + 0.05)
      })).toBeGreaterThanOrEqual(4.5)
    }
  }
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
      if (request.url === '/anthropic/v1/models') {
        if (request.headers['x-api-key'] !== 'e2e-anthropic-key' || request.headers['anthropic-version'] !== '2023-06-01') { response.writeHead(401); response.end(); return }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ data: [{ id: 'native-model' }], has_more: false, last_id: 'native-model' })); return
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      const ids = request.headers.authorization === 'Bearer e2e-second-key' ? ['other-fast-model', 'other-chat'] : ['gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol']
      response.end(JSON.stringify({ data: ids.map(id => ({ id, object: 'model', ...(id === 'gpt-6-astra' || id === 'gpt-6-sol' ? { context_window: id === 'gpt-6-astra' ? 4096 : 8192, effort: { supported_levels: id === 'gpt-6-astra' ? ['low', 'high', 'max'] : ['low', 'medium', 'high', 'max', 'ultra'], default_level: id === 'gpt-6-astra' ? 'high' : 'medium' } } : id === 'other-fast-model' ? { effort: { supported_levels: ['high'] } } : id === 'other-chat' ? { effort: { supported_levels: [] } } : {}) })) })); return
    }
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const payload = JSON.parse(body)
      if (request.url === '/anthropic/v1/messages') {
        if (request.headers['x-api-key'] !== 'e2e-anthropic-key' || request.headers['anthropic-version'] !== '2023-06-01') { response.writeHead(401); response.end(); return }
        nativeRequests.push(payload)
        const hasResult = payload.messages.at(-1)?.content?.some((block: { type: string }) => block.type === 'tool_result')
        const events = hasResult ? anthropicEvents('Anthropic 循环完成') : anthropicEvents('准备调用。', [{ ...testCall('toolu_test'), name: 'not_registered' }])
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')); return
      }
      requests.push({ ...payload, authorization: request.headers.authorization })
      if (request.headers.authorization === 'Bearer invalid-key') {
        response.writeHead(401); response.end('Invalid key'); return
      }
      const fileToolPrompt = payload.messages.some((message: { role: string; content: unknown }) => message.role === 'user' && typeof message.content === 'string' && message.content.includes('文件工具集成验证'))
      if (fileToolPrompt) {
        const hasResults = payload.messages.some((message: { role: string }) => message.role === 'tool')
        const calls = [
          { id: 'file_write', name: 'write', arguments: JSON.stringify({ path: 'generated.txt', content: 'before' }) },
          { id: 'file_read', name: 'read', arguments: JSON.stringify({ path: 'generated.txt' }) },
          { id: 'file_edit', name: 'edit', arguments: JSON.stringify({ path: 'generated.txt', edits: [{ oldText: 'before', newText: 'after' }] }) },
          { id: 'file_bash', name: 'bash', arguments: JSON.stringify({ command: 'cat generated.txt' }) }
        ]
        const stream = openAIResponse(hasResults ? '文件工具执行完成' : '', hasResults ? [] : calls)
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        void stream.text().then(body => response.end(body)); return
      }
      const prompt = payload.messages.at(-1)?.content || ''
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"content":"正在分析…"}}]}\n\n')
      const timer = setTimeout(() => {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '\n\n这是流式回答。\n\n```typescript\nconst answer = 42\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 流式 | 完成 |' }, finish_reason: 'stop' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
      }, prompt.includes('停止') ? 15_000 : prompt.includes('导航延续') ? 2_500 : 1_000)
      response.on('close', () => clearTimeout(timer))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

test.beforeEach(() => { failDiscovery = false; discoveries.length = 0; requests.length = 0; nativeRequests.length = 0; directory = mkdtempSync(join(tmpdir(), 'dcode-e2e-')) })
test.afterEach(async () => {
  await application?.close().catch(() => undefined)
  rmSync(directory, { recursive: true, force: true })
})
test.afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })

test('production read/bash/edit/write use the selected folder and recover it after restart', async () => {
  await launch()
  await authenticate('filetools', true)
  const project = join(directory, 'tool-project')
  mkdirSync(project)
  await application.evaluate(({ dialog }, project) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] }) }, project)
  await page.getByRole('button', { name: '添加附件', exact: true }).click()
  await page.getByRole('menuitem', { name: /添加文件夹/ }).click()
  const input = page.getByRole('textbox', { name: '消息', exact: true })
  await input.fill('文件工具集成验证')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.locator('article[data-role="assistant"][data-status="complete"]')).toContainText('文件工具执行完成')
  expect(readFileSync(join(project, 'generated.txt'), 'utf8')).toBe('after')
  const results = requests.at(-1)!.messages.filter(message => message.role === 'tool')
  expect(results.map(message => message.content)).toEqual([expect.stringContaining('已写入'), 'before', expect.stringMatching(/-before\n[\s\S]*\+after/), 'after'])
  expect(requests[0].messages[0].content).toContain(project)
  expect(JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')).conversations[0].messages[0].attachments[0].path).toBe(project)
  await application.close()
  await launch()
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '重新生成', exact: true }).click()
  await expect(page.locator('article[data-role="assistant"][data-status="complete"]')).toContainText('文件工具执行完成')
  expect(readFileSync(join(project, 'generated.txt'), 'utf8')).toBe('after')
  expect(requests.at(-1)!.messages[0].content).toContain(project)
})

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
  await verifyModelMenu('gpt-6-astra')
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
  await page.getByRole('button', { name: '测试并保存', exact: true }).press('Enter')
  await expect(page.getByRole('alert')).toContainText('连通测试未通过')
  expect(await page.evaluate(() => window.dcode.getState())).toEqual(savedModels)
  await page.getByRole('textbox', { name: '服务地址', exact: true }).fill(`${baseUrl}/secondary`)
  await page.getByRole('textbox', { name: 'API Key', exact: true }).fill('invalid-key')
  await page.getByRole('button', { name: '测试并保存', exact: true }).press('Enter')
  await expect(page.getByRole('alert')).toContainText('连通测试未通过')
  expect(await page.evaluate(() => window.dcode.getState())).toEqual(savedModels)
  await page.getByRole('button', { name: '关闭', exact: true }).click()

  await page.getByRole('button', { name: '切换模型', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'other-fast-model', exact: true })).toBeVisible()
  await page.getByRole('menuitem', { name: 'other-fast-model', exact: true }).click()
  await page.getByRole('button', { name: '模型强度选择', exact: true }).click()
  await expect(page.locator('.strength-level')).toHaveCount(1)
  await expect(page.getByRole('slider', { name: '模型强度', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '模型强度选择', exact: true }).click()
  await page.getByRole('button', { name: '切换模型', exact: true }).click()
  await page.getByRole('menuitem', { name: 'other-chat', exact: true }).click()
  await expect(page.getByRole('button', { name: '模型强度选择', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '模型强度选择', exact: true })).toContainText('不支持推理')
  await page.getByRole('button', { name: '切换模型', exact: true }).click()
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
  const cursor = page.locator('.generation-cursor')
  await composer.hover({ position: { x: 36, y: 20 } })
  await expect(composer).toBeDisabled()
  await expect(cursor).toHaveCSS('opacity', '1')
  await expect(composer).toHaveCSS('cursor', 'none')
  expect(await cursor.evaluate(element => getComputedStyle(element, '::after').animationIterationCount)).toBe('infinite')
  const initialRotation = await cursor.evaluate(element => getComputedStyle(element, '::after').transform)
  await expect.poll(() => cursor.evaluate(element => getComputedStyle(element, '::after').transform)).not.toBe(initialRotation)
  const inputBounds = (await composer.boundingBox())!
  await page.mouse.move(inputBounds.x + 96, inputBounds.y + 24)
  await expect.poll(async () => {
    const bounds = (await cursor.boundingBox())!
    return Math.abs(bounds.x + bounds.width / 2 - inputBounds.x - 96) + Math.abs(bounds.y + bounds.height / 2 - inputBounds.y - 24)
  }).toBeLessThan(2)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await cursor.evaluate(element => getComputedStyle(element, '::after').animationName)).toBe('none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.getByRole('button', { name: '停止生成', exact: true }).hover()
  await expect(cursor).toHaveCSS('opacity', '0')
  expect(requests.at(-1)).not.toHaveProperty('service_tier')
  await page.getByRole('button', { name: '停止生成', exact: true }).click()
  await expect(page.getByText('已停止生成', { exact: true })).toBeVisible()
  await expect(cursor).toHaveCount(0)
  await expect(composer).toBeEnabled()
  expect(await composer.evaluate(element => getComputedStyle(element).cursor)).not.toBe('none')
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
  await page.getByRole('button', { name: '切换模型', exact: true }).click()
  await verifyModelMenu('gpt-6-sol')
  await page.getByRole('button', { name: '切换模型', exact: true }).click()
  await page.getByRole('button', { name: '模型强度选择', exact: true }).click()
  await expect(page.locator('.strength-panel')).toHaveAttribute('data-theme', 'dark')
  expect(await page.locator('.strength-panel').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(37, 39, 34)')
  await page.getByRole('button', { name: '模型强度选择', exact: true }).click()
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
  await context.focus()
  await expect(page.getByRole('tooltip')).toContainText('窗口：4,096 tokens')
  await expect(page.getByRole('tooltip')).toContainText('剩余约')
  await expect(page.getByRole('tooltip')).toContainText('预估')
  await input.fill('请查看附件代码')
  await page.getByRole('button', { name: '模型强度选择', exact: true }).click()
  const track = page.locator('.strength-track')
  await expect(page.locator('.strength-rail')).toHaveCSS('height', '8px')
  await expect(track).toHaveCSS('height', '8px')
  expect(await track.evaluate(element => getComputedStyle(element, '::after').animationIterationCount)).toBe('infinite')
  const initialParticles = await track.evaluate(element => getComputedStyle(element, '::after').transform)
  await expect.poll(() => track.evaluate(element => getComputedStyle(element, '::after').transform)).not.toBe(initialParticles)
  await expect.poll(async () => {
    const handle = (await strength.boundingBox())!
    const rail = (await page.locator('.strength-rail').boundingBox())!
    return Math.abs(handle.y + handle.height / 2 - rail.y - rail.height / 2)
  }).toBeLessThan(1)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await track.evaluate(element => getComputedStyle(element, '::after').animationName)).toBe('none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  for (const level of ['low', 'high', 'max']) await expect(page.getByRole('button', { name: level, exact: true })).toBeVisible()
  await expect(page.locator('.strength-level')).toHaveCount(3)
  await expect(page.getByRole('button', { name: 'medium', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'ultra', exact: true })).toHaveCount(0)
  await strength.focus()
  await strength.press('Home')
  await expect(strength).toHaveAttribute('aria-valuetext', 'low')
  await expect(page.getByRole('button', { name: '切换模型', exact: true })).toBeEnabled()
  await strength.press('ArrowRight')
  await expect(strength).toHaveAttribute('aria-valuetext', 'high')
  await expect.poll(async () => {
    const state = await page.evaluate(() => window.dcode.getState()); return state.ok ? state.value.reasoningEffort : undefined
  }).toBe('high')
  await expect(strength).toBeEnabled()
  await expect.poll(async () => {
    const handle = await strength.boundingBox()
    const track = await page.locator('.strength-rail').boundingBox()
    return Math.abs(handle!.x + handle!.width / 2 - track!.x - track!.width / 2)
  }).toBeLessThan(1)
  await strength.click({ trial: true })
  const bounds = await strength.boundingBox()
  const rail = await page.locator('.strength-rail').boundingBox()
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
  await page.mouse.down()
  await page.mouse.move(rail!.x + rail!.width * 0.84, bounds!.y + bounds!.height / 2, { steps: 10 })
  await expect.poll(async () => Number(await strength.getAttribute('aria-valuenow'))).toBeGreaterThan(1.5)
  const continuous = Number(await strength.getAttribute('aria-valuenow'))
  expect(continuous).toBeGreaterThan(1.5)
  expect(continuous).toBeLessThan(1.9)
  expect(continuous % 1).not.toBe(0)
  expect(await page.locator('.strength-track').evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
  await page.mouse.up()
  await expect(strength).toHaveAttribute('aria-valuetext', 'max')
  await expect(page.getByRole('button', { name: '模型强度选择', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '切换模型', exact: true }).click()
  await page.getByRole('menuitem', { name: 'gpt-6-sol', exact: true }).click()
  await page.getByRole('button', { name: '模型强度选择', exact: true }).click()
  for (const level of ['low', 'medium', 'high', 'max', 'ultra']) await expect(page.getByRole('button', { name: level, exact: true })).toBeVisible()
  await expect(page.locator('.strength-level')).toHaveCount(5)
  await expect(strength).toHaveAttribute('aria-valuetext', 'medium')
  await page.getByRole('button', { name: 'ultra', exact: true }).click()
  await expect.poll(async () => { const state = await page.evaluate(() => window.dcode.getState()); return state.ok ? state.value.reasoningEffort : undefined }).toBe('ultra')
  await expect(page.getByRole('button', { name: '模型强度选择', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '切换模型', exact: true }).click()
  await page.getByRole('menuitem', { name: 'gpt-6-astra', exact: true }).click()
  await page.getByRole('button', { name: '模型强度选择', exact: true }).click()
  await expect(strength).toHaveAttribute('aria-valuetext', 'max')
  await page.getByRole('button', { name: 'high', exact: true }).click()
  await expect(page.getByRole('button', { name: '模型强度选择', exact: true })).toBeEnabled()
  await input.click({ position: { x: 8, y: 8 } })
  await expect(page.locator('.strength-panel')).not.toBeVisible()
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
  await page.getByRole('button', { name: '模型强度选择', exact: true }).click()
  const panelBounds = await page.locator('.strength-panel').boundingBox()
  expect(panelBounds!.x).toBeGreaterThanOrEqual(0)
  expect(panelBounds!.x + panelBounds!.width).toBeLessThanOrEqual(820)
  expect(panelBounds!.y).toBeGreaterThanOrEqual(0)
  await page.getByRole('button', { name: '模型强度选择', exact: true }).click()
  const modelBounds = await page.getByRole('button', { name: '切换模型', exact: true }).boundingBox()
  expect(modelBounds!.x).toBeGreaterThan(plusBounds!.x + plusBounds!.width)
  for (const control of [context, page.getByRole('button', { name: '模型强度选择', exact: true }), page.getByRole('button', { name: '快速模式', exact: true })]) {
    const bounds = await control.boundingBox(); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(820)
  }
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.locator('article[data-role="assistant"][data-status="complete"]')).toHaveCount(1)
  expect(requests.at(-1)?.reasoning_effort).toBe('high')
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
  await expect(page.getByRole('button', { name: '模型强度选择', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '模型强度选择', exact: true })).toContainText('强度未知')
  await context.hover()
  await context.focus()
  await expect(page.getByRole('tooltip')).toContainText('窗口：未知')
  await input.click()
  await page.getByRole('button', { name: '切换模型', exact: true }).click()
  await page.getByRole('menuitem', { name: 'gpt-6-sol', exact: true }).click()
  await application.close(); await launch()
  await expect(page.getByRole('button', { name: '切换模型', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '模型强度选择', exact: true }).click()
  await expect(page.getByRole('slider', { name: '模型强度', exact: true })).toHaveAttribute('aria-valuetext', 'ultra')
  await page.getByRole('button', { name: '模型强度选择', exact: true }).click()
  await expect(page.locator('article[data-role="user"]')).toContainText('sample-project')
  await page.getByRole('button', { name: '新对话', exact: true }).click()
  const resumedInput = page.getByRole('textbox', { name: '消息', exact: true })
  await resumedInput.fill('取消后保留的草稿')
  await application.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }) })
  await page.getByRole('button', { name: '添加附件', exact: true }).click(); await page.getByRole('menuitem', { name: /添加文件$/ }).click()
  await expect(resumedInput).toHaveValue('取消后保留的草稿')
})

test('welcome cloud animation and unrestricted folder selection, replacement and sending', async () => {
  await launch()
  await authenticate('workspace', true)
  const cloud = page.getByRole('button', { name: '旋转云朵', exact: true })
  const turn = page.locator('.welcome-cloud-turn')
  const heading = page.getByRole('heading', { level: 1 })
  const input = page.getByRole('textbox', { name: '消息', exact: true })
  await expect(heading).toHaveText('今天想写点什么？')
  await expect(page.locator('.welcome .brand-icon')).toHaveCount(0)
  const cursor = page.locator('.welcome-cloud-cursor')
  await expect.poll(() => cursor.evaluate(element => Number(getComputedStyle(element).opacity)), { intervals: [50, 100] }).toBeGreaterThan(.95)
  await expect.poll(() => cursor.evaluate(element => Number(getComputedStyle(element).opacity)), { intervals: [50, 100] }).toBeLessThan(.05)
  await expect.poll(() => cursor.evaluate(element => Number(getComputedStyle(element).opacity)), { intervals: [50, 100] }).toBeGreaterThan(.95)
  const before = await turn.evaluate(element => getComputedStyle(element).transform)
  await cloud.click()
  await expect.poll(() => turn.evaluate(element => getComputedStyle(element).transform)).not.toBe(before)
  await expect(turn).toHaveCSS('transition-duration', '0.95s')
  await expect(page.locator('.welcome-cloud-ripple')).toHaveCSS('animation-name', 'cloud-ripple')
  await turn.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)) })
  await cloud.press('Enter')
  await expect(turn).toHaveAttribute('style', 'transform: rotate(720deg);')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await cloud.click()
  await expect(turn).toHaveCSS('transition-duration', '0s')
  await expect(page.locator('.welcome-cloud-float')).toHaveCSS('animation-name', 'none')
  await expect(page.locator('.welcome-cloud-ripple')).toHaveCSS('animation-name', 'none')
  await expect(cursor).toHaveCSS('animation-name', 'none')
  await expect(cursor).toHaveCSS('opacity', '1')
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  const project = join(directory, 'sample-project')
  const replacement = join(directory, '另一个工作目录')
  const empty = join(directory, '空目录')
  const source = join(directory, 'standalone.ts')
  for (const folder of [project, replacement, empty]) mkdirSync(folder)
  for (let index = 0; index < 60; index++) writeFileSync(join(project, `file-${index}.ts`), `export const value${index} = ${index}`)
  writeFileSync(join(project, 'large.txt'), 'a'.repeat(600 * 1024) + 'full-folder-end')
  writeFileSync(join(replacement, 'code.ts'), 'replacement-content')
  writeFileSync(source, 'standalone-content')
  await application.evaluate(({ dialog }, paths) => {
    let index = 0
    dialog.showOpenDialog = async (...args: unknown[]) => {
      const options = args.at(-1) as Electron.OpenDialogOptions
      if (!options.properties?.includes('openDirectory')) return { canceled: false, filePaths: [paths.source] }
      const path = [paths.project, null, paths.replacement, paths.empty, paths.project][index++]
      return { canceled: path === null, filePaths: path ? [path] : [] }
    }
  }, { project, replacement, empty, source })
  await input.fill('保留输入并读取目录')
  const add = page.getByRole('button', { name: '添加附件', exact: true })
  await add.click(); await page.getByRole('menuitem', { name: /添加文件$/ }).click()
  await add.click(); await page.getByRole('menuitem', { name: /添加文件夹/ }).click()
  await expect(heading).toContainText('今天想在 sample-project 中写点什么？')
  await expect(page.getByText('sample-project · 61 个文件', { exact: true })).toBeVisible()
  const folderName = page.getByRole('button', { name: '选择工作文件夹', exact: true })
  await expect(folderName).toHaveCSS('text-decoration-line', 'underline')
  /** 从标题菜单更换目录，依赖上方主进程选择器 mock；首次取消必须保留草稿。 */
  async function chooseFolder(): Promise<void> {
    await folderName.click()
    await page.getByRole('menuitem', { name: /选择文件夹…$/ }).click()
    await expect(add).toBeEnabled()
  }
  await chooseFolder()
  await expect(folderName).toHaveText('sample-project')
  await chooseFolder()
  await expect(folderName).toHaveText('另一个工作目录')
  await expect(page.getByRole('button', { name: '移除附件 sample-project', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '移除附件 standalone.ts', exact: true })).toBeVisible()
  await expect(input).toHaveValue('保留输入并读取目录')
  await chooseFolder()
  await expect(folderName).toHaveText('空目录')
  await expect(page.getByText('空目录 · 0 个文件', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '移除附件 空目录', exact: true }).click()
  await expect(heading).toHaveText('今天想写点什么？')
  await add.click(); await page.getByRole('menuitem', { name: /添加文件夹/ }).click()
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(820, 620))
  expect(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth)).toBe(true)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.locator('article[data-role="assistant"][data-status="complete"]')).toHaveCount(1)
  expect(requests.at(-1)?.messages.at(-1)?.content).toContain('full-folder-end')
  expect(requests.at(-1)?.messages.at(-1)?.content).toContain('value59')
  expect(requests.at(-1)?.messages.at(-1)?.content).toContain('standalone-content')
})

test('sidebar resize limits, collapse, toolbar restore and draft preservation', async () => {
  await launch()
  await authenticate('sidebar-user', true)
  const sidebar = page.getByRole('complementary', { includeHidden: true })
  const input = page.getByRole('textbox', { name: '消息', exact: true })
  await input.fill('调整布局时保留的草稿')

  /** 使用真实鼠标拖动 Splitter，持续移动覆盖实时布局与阈值收起，避免相邻手势被当成双击。 */
  async function dragSidebar(target: number): Promise<void> {
    const handle = await page.getByRole('separator').boundingBox()
    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2)
    await page.mouse.down()
    await page.mouse.move(target, handle!.y + handle!.height / 2, { steps: 24 })
    await page.mouse.up()
  }

  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeCloseTo(246, 0)
  await dragSidebar(350)
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeCloseTo(350, 0)
  await dragSidebar(700)
  await expect.poll(async () => Math.abs((await sidebar.boundingBox())!.width - await page.evaluate(() => innerWidth / 3))).toBeLessThan(1)
  await dragSidebar(220)
  await expect.poll(async () => Math.abs((await sidebar.boundingBox())!.width - 220)).toBeLessThan(1)
  await dragSidebar(140)
  await expect(sidebar).not.toBeVisible()
  const show = page.getByRole('button', { name: '显示侧边栏', exact: true })
  await expect(show).toHaveAttribute('aria-expanded', 'false')
  expect((await show.boundingBox())!.x).toBeGreaterThan(90)
  await expect.poll(async () => (await page.getByRole('main').boundingBox())!.width).toBe(await page.evaluate(() => innerWidth))
  await expect(input).toHaveValue('调整布局时保留的草稿')
  for (let index = 0; index < 6; index++) {
    await page.keyboard.press('Tab')
    expect(await sidebar.evaluate(element => element.contains(document.activeElement))).toBe(false)
  }
  await show.click()
  await expect.poll(async () => Math.abs((await sidebar.boundingBox())!.width - 220)).toBeLessThan(1)
  await page.getByRole('button', { name: '隐藏侧边栏', exact: true }).click()
  await expect(sidebar).not.toBeVisible()
  await show.click()
  await expect.poll(async () => Math.abs((await sidebar.boundingBox())!.width - 220)).toBeLessThan(1)
  await dragSidebar(350)
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(820, 620))
  await expect.poll(async () => Math.abs((await sidebar.boundingBox())!.width - await page.evaluate(() => innerWidth / 3))).toBeLessThan(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth)).toBe(true)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByText('深色', { exact: true }).click()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.locator('.shell')).toHaveAttribute('data-theme', 'dark')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: '隐藏侧边栏', exact: true }).click()
  await expect(sidebar).not.toBeVisible()
  await expect(input).toHaveValue('调整布局时保留的草稿')
  await show.click()
  await expect(sidebar).toBeVisible()
  expect(await sidebar.evaluate(element => getComputedStyle(element.parentElement!.parentElement!).transitionDuration)).toBe('0s')
  await input.fill('布局调整之后发送')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '隐藏侧边栏', exact: true }).click()
  await expect(page.getByRole('region', { name: '对话消息', exact: true }).getByText('布局调整之后发送', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '重新生成', exact: true })).toBeVisible()
  await show.click()
  await expect(page.getByRole('button', { name: '布局调整之后发送', exact: true })).toBeVisible()
  await expect(input).toHaveValue('')
})

test('message navigation previews, scroll tracking and streaming history reading', async () => {
  test.setTimeout(90_000)
  await launch()
  await authenticate('navigation-user', true)
  const input = page.getByRole('textbox', { name: '消息', exact: true })
  const navigation = page.getByRole('navigation', { name: '消息导航', exact: true })
  const viewport = page.locator('.workspace')
  const first = navigation.getByRole('button', { name: '跳转到第 1 轮对话', exact: true })
  const second = navigation.getByRole('button', { name: '跳转到第 2 轮对话', exact: true })
  const preview = page.locator('.message-preview')
  await expect(navigation).toHaveCount(0)
  for (let index = 1; index <= 11; index++) {
    await input.fill(`导航问题 ${index}\n${index <= 2 ? '需要解释这段代码的执行流程。\n'.repeat(18) : '补充一个具体的问题。'}`)
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page.getByRole('button', { name: '重新生成', exact: true })).toBeVisible()
  }
  await expect(navigation.getByRole('button')).toHaveCount(11)
  const last = navigation.getByRole('button', { name: '跳转到第 11 轮对话', exact: true })
  await expect(last).toHaveAttribute('aria-current', 'step')
  await expect.poll(async () => {
    const rail = await navigation.boundingBox()
    const button = await last.boundingBox()
    return button!.y >= rail!.y && button!.y + button!.height <= rail!.y + rail!.height + 1
  }).toBe(true)
  await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2)
  const historyPosition = await viewport.evaluate(element => element.scrollTop)
  await first.scrollIntoViewIfNeeded()
  await expect.poll(async () => {
    const rail = await navigation.boundingBox()
    const button = await first.boundingBox()
    return button!.y >= rail!.y && button!.y + button!.height <= rail!.y + rail!.height + 1
  }).toBe(true)
  await first.hover()
  await expect(preview).toContainText('导航问题 1')
  await expect(preview.locator('.message-preview-answer')).toContainText('这是流式回答')
  expect(Math.abs(await viewport.evaluate(element => element.scrollTop) - historyPosition)).toBeLessThanOrEqual(2)
  const lines = navigation.locator('.message-navigation-line')
  await expect.poll(() => lines.first().evaluate(element => element.getBoundingClientRect().width)).toBeLessThanOrEqual(16.1)
  const middle = navigation.getByRole('button', { name: '跳转到第 6 轮对话', exact: true })
  await middle.hover()
  // 检查悬停峰值两侧的实际长度与对称性，阅读位置在末轮时也不能形成第二个长峰。
  await expect.poll(() => lines.evaluateAll(elements => {
    const widths = elements.map(element => element.getBoundingClientRect().width)
    return widths[5] > 15.9 && widths[5] <= 16.1 && widths[4] > widths[3] && widths[3] > widths[2]
      && widths[6] > widths[7] && widths[7] > widths[8] && Math.abs(widths[4] - widths[6]) < 0.1
      && widths[10] < widths[8] && widths.every(width => width >= 3.9)
  })).toBe(true)
  await expect(last).toHaveAttribute('aria-current', 'step')
  const middleBounds = (await middle.boundingBox())!
  await navigation.evaluate(element => { (element as Element & { motionSamples?: Promise<number[]> }).motionSamples = new Promise<number[]>(resolve => {
    element.addEventListener('pointermove', () => {
      const widths: number[] = []
      /** 采集真实浏览器的连续动画帧，确认鼠标在同一按钮内移动时长度逐帧变化。 */
      function sample(): void {
        widths.push(element.querySelectorAll('.message-navigation-line')[5].getBoundingClientRect().width)
        if (widths.length < 8) requestAnimationFrame(sample)
        else resolve(widths)
      }
      requestAnimationFrame(sample)
    }, { once: true })
  }) })
  await page.mouse.move(middleBounds.x + middleBounds.width / 2, middleBounds.y + middleBounds.height * 0.75)
  const samples = await navigation.evaluate(async element => {
    const target = element as Element & { motionSamples?: Promise<number[]> }
    const values = await target.motionSamples!
    delete target.motionSamples
    return values
  })
  expect(new Set(samples.map(width => width.toFixed(3))).size).toBeGreaterThan(3)
  expect(samples[0]).toBeGreaterThan(samples.at(-1)!)
  await expect.poll(() => lines.evaluateAll(elements => elements[5].getBoundingClientRect().width < 15.95
    && elements[6].getBoundingClientRect().width > elements[4].getBoundingClientRect().width)).toBe(true)
  await expect(preview).toHaveCount(1)
  await preview.hover()
  await expect.poll(() => lines.evaluateAll(elements => elements[10].getBoundingClientRect().width > 15.9
    && elements[5].getBoundingClientRect().width < 4.1)).toBe(true)
  await input.hover()
  await expect(preview).toHaveCount(0)
  await first.focus()
  await first.press('Escape')
  await expect(preview).toHaveCount(0)
  await input.fill('导航不会清空的草稿')
  await first.click()
  await expect(first).toHaveAttribute('aria-current', 'step')
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeLessThan(50)
  await expect(input).toHaveValue('导航不会清空的草稿')
  await viewport.evaluate(element => {
    const target = element.querySelectorAll('article[data-role="user"]')[1]
    element.scrollTo({ top: target.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop - 24, behavior: 'instant' })
  })
  await expect(second).toHaveAttribute('aria-current', 'step')
  await second.focus()
  await first.focus()
  await expect(preview).toHaveCount(1)
  await expect(preview).toBeVisible()
  await first.press('Enter')
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeLessThan(50)
  await expect(preview).toHaveCount(0)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await second.click()
  await expect(second).toHaveAttribute('aria-current', 'step')
  expect(await second.locator('.message-navigation-line').evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByText('深色', { exact: true }).click()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(820, 620))
  await first.focus()
  await expect(preview).toHaveCount(1)
  await expect(preview).toHaveAttribute('data-theme', 'dark')
  await expect.poll(async () => {
    const rect = await preview.boundingBox()
    const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    return Boolean(rect && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= size.width && rect.y + rect.height <= size.height)
  }).toBe(true)
  await first.press('Escape')
  await page.getByRole('button', { name: '隐藏侧边栏', exact: true }).click()
  await expect(navigation).toBeVisible()
  await second.click()
  await expect(second).toHaveAttribute('aria-current', 'step')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await input.fill('导航延续：继续生成回复')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible()
  await expect(navigation.getByRole('button')).toHaveCount(12)
  await first.click()
  await expect(first).toHaveAttribute('aria-current', 'step')
  await expect(page.getByRole('button', { name: '重新生成', exact: true })).toBeAttached()
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeLessThan(50)
  await expect(first).toHaveAttribute('aria-current', 'step')
  await page.getByRole('button', { name: '显示侧边栏', exact: true }).click()
  const state = await page.evaluate(() => window.dcode.getState())
  const title = state.ok ? state.value.conversations[0].title : ''
  await first.focus()
  await expect(preview).toHaveCount(1)
  await expect(preview).toBeVisible()
  await page.getByRole('button', { name: '新对话', exact: true }).click()
  await expect(navigation).toHaveCount(0)
  await expect(preview).toHaveCount(0)
  await page.getByRole('button', { name: title, exact: true }).click()
  await expect(navigation.getByRole('button')).toHaveCount(12)
  await expect(navigation.getByRole('button', { name: '跳转到第 12 轮对话', exact: true })).toHaveAttribute('aria-current', 'step')
})

test('native protocol selection, safe tool failure loop and restart', async () => {
  await launch()
  await authenticate('native-api', true)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('combobox', { name: '编辑服务配置', exact: true }).click()
  await page.getByText('添加服务', { exact: true }).click()
  await page.getByRole('textbox', { name: '配置名称', exact: true }).fill('原生服务')
  await page.getByRole('textbox', { name: '服务地址', exact: true }).fill(`${baseUrl}/anthropic/v1`)
  await page.getByRole('textbox', { name: 'API Key', exact: true }).fill('e2e-anthropic-key')
  await page.getByRole('combobox', { name: 'API 协议', exact: true }).click()
  await page.getByText('Anthropic Messages', { exact: true }).click()
  await page.getByRole('button', { name: '测试并保存', exact: true }).click()
  await expect(page.getByText('连通测试通过，配置已保存。', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByRole('button', { name: '切换模型', exact: true })).toContainText('native-model')
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('工具循环验证')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.locator('article[data-status="complete"][data-role="assistant"]')).toContainText('Anthropic 循环完成')
  expect(nativeRequests).toHaveLength(2)
  expect(nativeRequests[1].messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_test', content: '工具未注册。', is_error: true }] })
  expect(nativeRequests[0].system).toContain('DCode')
  const state = await page.evaluate(() => window.dcode.getState())
  expect(state.ok && state.value.providers.find(provider => provider.name === '原生服务')?.api).toBe('anthropic-messages')
  expect(JSON.stringify(state)).not.toContain('e2e-anthropic-key')
  await application.close()
  await launch()
  await expect(page.getByRole('button', { name: '切换模型', exact: true })).toContainText('native-model')
  await expect(page.locator('article[data-role="assistant"]')).toContainText('Anthropic 循环完成')
})

test('live DeepSeek model test and streaming smoke', async () => {
  test.skip(process.env.DCODE_LIVE_TEST !== '1', 'Opt-in real provider request')
  test.setTimeout(90_000)
  await launch(true)
  await authenticate('live-smoke', true)
  await expect(page.getByRole('button', { name: '上下文用量', exact: true })).toHaveAttribute('data-limit', '1048576')
  await page.getByRole('button', { name: '模型强度选择', exact: true }).click()
  await expect(page.locator('.strength-level')).toHaveCount(3)
  for (const level of ['low', 'high', 'max']) await expect(page.getByRole('button', { name: level, exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'medium', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'ultra', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '模型强度选择', exact: true }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '测试并保存', exact: true }).click()
  await expect(page.getByText('连通测试通过，配置已保存。', { exact: true })).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('这是连接测试。请仅回答：连接成功')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.locator('article[data-status="complete"][data-role="assistant"]')).toContainText('连接成功', { timeout: 60_000 })
})
