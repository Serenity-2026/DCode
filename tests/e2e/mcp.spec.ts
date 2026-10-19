import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mcpHttp } from '../fixtures/mcp-http'
import { openAIResponse } from '../unit/llm-fixtures'

test('manages MCP settings, persists encrypted headers, calls tools through the Agent and disables them', async ({}, info) => {
  test.setTimeout(90_000)
  const directory = mkdtempSync(join(tmpdir(), 'dcode-mcp-e2e-'))
  const workspace = join(directory, 'workspace')
  mkdirSync(workspace)
  let releaseTools!: () => void
  const toolsReady = new Promise<void>(resolve => { releaseTools = resolve })
  const mcp = await mcpHttp({ beforeListTools: () => toolsReady })
  mcp.state.auth = true; mcp.state.bearer = 'e2e-mcp-private-token'
  const model = createServer(async (request, response) => {
    if (request.method === 'GET') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'mcp-test-model' }] })); return }
    let body = ''
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body)
    const tool = payload.tools?.find((t: { function: { name: string } }) => t.function.name.startsWith('mcp__docs__echo'))
    const result = payload.messages.find((m: { role: string }) => m.role === 'tool')
    const stream = openAIResponse(!payload.tools ? '{"suggestion":""}' : result ? `工具返回：${result.content}` : tool ? '' : 'MCP 已停用', tool && !result ? [{ id: 'mcp-call', name: tool.function.name, arguments: JSON.stringify({ text: '端到端验证' }) }] : [])
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(await stream.text())
  })
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
  let application: ElectronApplication | undefined
  const launch = async () => {
    application = await electron.launch({ args: ['.'], env: { ...process.env, DCODE_USER_DATA_DIR: directory, BASE_URL: `http://127.0.0.1:${(model.address() as AddressInfo).port}`, API_KEY: 'model-private-token', MODEL: 'mcp-test-model' } })
    const page = await application.firstWindow()
    await application.evaluate(({ dialog, BrowserWindow }, workspace) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] }); BrowserWindow.getAllWindows()[0].blur() }, workspace)
    return page
  }
  try {
    let page = await launch()
    await page.getByText('注册', { exact: true }).click()
    await page.getByRole('textbox', { name: '账号', exact: true }).fill('mcp-user')
    await page.getByRole('textbox', { name: '密码', exact: true }).fill('mcp-test-password')
    await page.getByRole('textbox', { name: '确认密码', exact: true }).fill('mcp-test-password')
    await page.getByRole('button', { name: '注册并登录' }).click()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: 'MCP 服务器', exact: true }).click()
    await page.getByRole('button', { name: '添加 MCP 服务器', exact: true }).click()
    await page.getByRole('textbox', { name: 'MCP 名称', exact: true }).fill('docs')
    await page.getByRole('combobox', { name: 'MCP 连接方式' }).click()
    await page.getByText('远程服务（Streamable HTTP）', { exact: true }).click()
    await page.getByRole('textbox', { name: 'MCP 服务地址' }).fill(`${mcp.url}/mcp`)
    await page.getByRole('combobox', { name: 'MCP 认证方式' }).click()
    await page.getByText('请求头 / Token', { exact: true }).click()
    await page.getByRole('textbox', { name: 'MCP 凭据' }).fill(JSON.stringify({ Authorization: 'Bearer e2e-mcp-private-token' }))
    await page.getByRole('button', { name: '保存 MCP 服务器', exact: true }).click()
    const card = page.getByRole('article', { name: 'MCP docs' })
    await expect(card).toBeVisible()
    expect(readFileSync(join(directory, 'state.json'), 'utf8')).not.toContain('e2e-mcp-private-token')
    await card.getByRole('button', { name: '连接 / 重连', exact: true }).click()
    await expect.poll(() => mcp.requests.some(r => r.method === 'tools/list')).toBe(true)
    await expect(card).toContainText('连接中')
    const connect = card.getByRole('button', { name: '连接 / 重连', exact: true })
    await expect(connect).toBeDisabled()
    await expect(connect.getByRole('img', { name: 'loading' })).toBeVisible()
    for (const name of ['断开', '编辑', '删除']) await expect(card.getByRole('button', { name, exact: true })).toBeDisabled()
    releaseTools()
    await expect(card).toContainText('已连接')
    await expect(connect).toBeEnabled()
    await expect(connect.getByRole('img', { name: 'loading' })).toHaveCount(0)
    for (const name of ['断开', '编辑', '删除']) await expect(card.getByRole('button', { name, exact: true })).toBeEnabled()
    mcp.state.bearer = 'changed-token'
    await connect.click()
    await expect(card).toContainText('需要认证')
    await expect(connect).toBeEnabled()
    await expect(connect.getByRole('img', { name: 'loading' })).toHaveCount(0)
    for (const name of ['断开', '编辑', '删除']) await expect(card.getByRole('button', { name, exact: true })).toBeEnabled()
    mcp.state.bearer = 'e2e-mcp-private-token'
    await connect.click()
    await expect(card).toContainText('已连接')
    await card.getByRole('button', { name: '查看工具' }).click()
    await expect(page.getByText('Echo MCP input', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.screenshot({ path: info.outputPath('mcp-settings.png') })
    await page.keyboard.press('Escape')
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('调用 MCP 验证')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect(page.locator('article[data-role="assistant"][data-status="complete"]')).toContainText('MCP:端到端验证')
    const snapshot = await page.evaluate(() => window.dcode.getState())
    if (!snapshot.ok) throw new Error(snapshot.error)
    expect(snapshot.value.usageRecords?.flatMap(r => r.tools)).toContainEqual({ kind: 'mcp', name: 'docs/echo', count: 1 })
    await application!.close()
    page = await launch()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: 'MCP 服务器', exact: true }).click()
    const restored = page.getByRole('article', { name: 'MCP docs' })
    await expect(restored).toContainText('未连接')
    await restored.getByRole('button', { name: '编辑', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'MCP 凭据' })).toHaveValue('')
    await page.keyboard.press('Escape')
    await restored.getByRole('switch', { name: '启用 docs' }).click()
    await expect(restored).toContainText('已停用')
    await page.keyboard.press('Escape')
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('停用验证')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect(page.locator('article[data-role="assistant"][data-status="complete"]').last()).toContainText('MCP 已停用')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: 'MCP 服务器', exact: true }).click()
    await page.getByRole('article', { name: 'MCP docs' }).getByRole('button', { name: '删除', exact: true }).click()
    await page.getByRole('dialog').filter({ hasText: '删除 docs？' }).getByRole('button', { name: '删除', exact: true }).click()
    await expect(page.getByRole('article', { name: 'MCP docs' })).toHaveCount(0)
  } finally {
    releaseTools()
    await application?.close().catch(() => undefined)
    await mcp.close()
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  }
})
