import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'

let server: Server
let baseUrl: string
let directory: string
let application: ElectronApplication
let page: Page
const requests: { role: string; content: string }[][] = []

async function launch(): Promise<void> {
  application = await electron.launch({ args: ['.'], env: {
    ...process.env, DCODE_USER_DATA_DIR: directory,
    DEEPSEEK_BASE_URL: baseUrl, DEEPSEEK_API_KEY: 'e2e-local-key', DEEPSEEK_MODEL: 'test-model'
  } })
  page = await application.firstWindow()
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible()
}

test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'dcode-e2e-'))
  server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const payload = JSON.parse(body)
      requests.push(payload.messages)
      const prompt = payload.messages.at(-1)?.content || ''
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"content":"正在分析…"}}]}\n\n')
      const slow = prompt.includes('停止')
      const timer = setTimeout(() => {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '\n\n这是流式回答。\n\n```typescript\nconst answer = 42\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 流式 | 完成 |' }, finish_reason: 'stop' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
      }, slow ? 15_000 : 1_000)
      response.on('close', () => clearTimeout(timer))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

test.afterAll(async () => {
  await application?.close().catch(() => undefined)
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(directory, { recursive: true, force: true })
})

test('desktop streaming, stop/retry, users, settings and restart persistence', async () => {
  await launch()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await expect(page.getByRole('heading', { name: '今天想写点什么？' })).toBeVisible()
  await page.screenshot({ path: join(tmpdir(), 'dcode-welcome.png') })
  expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined')
  expect(await page.evaluate(async () => JSON.stringify(await window.dcode.getState()))).not.toContain('e2e-local-key')

  await page.getByRole('button', { name: '实现一个功能' }).click()
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue(/梳理需求/)
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('实现一个 TypeScript 函数')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByText('正在分析…', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '管理用户', exact: true })).toBeDisabled()
  await expect(page.locator('article[data-status="complete"][data-role="assistant"]')).toHaveCount(1)
  await expect(page.locator('pre')).toContainText('const answer = 42')
  await expect(page.locator('table')).toContainText('流式')
  await page.getByRole('button', { name: '复制代码', exact: true }).click()
  await expect(page.getByText('已复制', { exact: true })).toBeVisible()
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('const answer = 42')
  await page.screenshot({ path: join(tmpdir(), 'dcode-chat.png') })

  await page.getByRole('textbox', { name: '消息', exact: true }).fill('请停止这次生成')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.locator('article[data-status="streaming"]')).toContainText('正在分析…')
  await page.getByRole('button', { name: '停止生成', exact: true }).click()
  await expect(page.getByText('已停止生成', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '重新生成', exact: true }).click()
  await expect(page.locator('article[data-status="streaming"]')).toContainText('正在分析…')
  expect(requests.at(-1)?.filter(m => m.role === 'user')).toHaveLength(2)
  expect(requests.at(-1)?.at(-2)?.role).toBe('assistant')
  await page.getByRole('button', { name: '停止生成', exact: true }).click()

  await page.getByRole('button', { name: '管理用户', exact: true }).click()
  await page.getByRole('textbox', { name: '新用户名称', exact: true }).fill('测试用户')
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.getByRole('heading', { name: '今天想写点什么？' })).toBeVisible()
  await expect(page.getByText('暂无对话', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '管理用户', exact: true }).click()
  await page.getByRole('button', { name: '编辑用户 测试用户', exact: true }).click()
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('第二个用户')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('第二个用户', { exact: true })).toHaveCount(2)
  await page.getByRole('button', { name: '切换', exact: true }).click()
  await page.getByRole('button', { name: '实现一个 TypeScript 函数', exact: true }).click()
  await expect(page.getByText('已停止生成', { exact: true })).toBeVisible()

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
  await expect(page.locator('.shell')).toHaveAttribute('data-theme', 'dark')
  await expect(page.getByRole('button', { name: '函数讨论', exact: true })).toBeVisible()
  await expect(page.getByText('已停止生成', { exact: true })).toBeVisible()
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(820, 620))
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }))
  expect(dimensions.width).toBe(dimensions.viewport)

  await page.getByRole('button', { name: '管理对话 函数讨论', exact: true }).click()
  await page.getByRole('menuitem', { name: /删除/ }).click()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByText('暂无对话', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '管理用户', exact: true }).click()
  await page.getByRole('button', { name: '删除用户 第二个用户', exact: true }).click()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByRole('button', { name: '删除用户 开发者', exact: true })).toBeDisabled()
  expect(errors).toEqual([])
})

test('live DeepSeek streaming smoke', async () => {
  test.skip(process.env.DCODE_LIVE_TEST !== '1', 'Opt-in real provider request')
  await application?.close().catch(() => undefined)
  application = await electron.launch({ args: ['.'], env: {
    ...process.env, DCODE_USER_DATA_DIR: directory, DEEPSEEK_BASE_URL: 'https://api.deepseek.com'
  } })
  page = await application.firstWindow()
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('这是连接测试。请仅回答：连接成功')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.locator('article[data-status="complete"][data-role="assistant"]')).toContainText('连接成功', { timeout: 60_000 })
})
