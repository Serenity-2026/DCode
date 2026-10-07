import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { CodingTools } from '../../src/main/infrastructure/tools/coding-tools'
import { toolValidator } from '../../src/main/infrastructure/tool-schema'
import { ToolExecutionError, type ToolOutput } from '../../src/main/domain/llm'
import { AgentSession } from '../../src/main/services/agent-session'
import { readAttachments } from '../../src/main/infrastructure/attachments'
import { anthropicResponse, openAIResponse } from './llm-fixtures'
import { create, createAgent, config, cleanup } from './helpers'
import type { ModelApi } from '../../src/shared/types'
import { contextMessages, estimateContext } from '../../src/shared/context'

const fixtures: { directory: string; tools: CodingTools }[] = []
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Z9sAAAAASUVORK5CYII=', 'base64')

/** 每个测试仅访问自身临时目录，调用真实生产 handler 和参数校验。 */
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dcode-tools-unit-'))
  const tools = new CodingTools()
  tools.setDirectory(directory)
  fixtures.push({ directory, tools })
  const run = (name: string, args: Record<string, unknown>, signal = new AbortController().signal) => {
    const tool = tools.tools.find(tool => tool.name === name)!
    expect(toolValidator(tool)(args)).toBe(true)
    return tool.execute(args, signal)
  }
  return { directory, tools, run }
}

/** 等待真实子进程创建标记文件，避免依靠固定延迟触发取消。 */
async function waitFile(path: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error('子进程没有创建标记文件。')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

afterEach(() => {
  vi.unstubAllGlobals(); cleanup()
  for (const { directory, tools } of fixtures.splice(0)) { tools.dispose(); rmSync(directory, { recursive: true, force: true }) }
})

it('registers only the four pi tools and rejects malformed arguments without conversion', () => {
  const { tools } = fixture()
  expect(tools.tools.map(tool => tool.name)).toEqual(['read', 'bash', 'edit', 'write'])
  const valid = (name: string, args: unknown) => toolValidator(tools.tools.find(tool => tool.name === name)!)(args)
  expect(valid('read', { path: 'a', offset: 0 })).toBe(false)
  expect(valid('read', { path: 'a', limit: 1.5 })).toBe(false)
  expect(valid('bash', { command: 'pwd', timeout: -1 })).toBe(false)
  expect(valid('bash', { command: 'pwd', timeout: 2_147_484 })).toBe(false)
  expect(valid('edit', { path: 'a', oldText: 'a', newText: 'b' })).toBe(false)
  expect(valid('edit', { path: 'a', edits: '[]' })).toBe(false)
  expect(valid('edit', { path: 'a', edits: [] })).toBe(false)
  expect(valid('write', { path: 'a', content: 12 })).toBe(false)
  expect(valid('write', { path: 'a', content: '', unknown: true })).toBe(false)
})

it('requires an explicit working directory and never inherits the application cwd', async () => {
  const { tools, run } = fixture()
  tools.setDirectory()
  await expect(run('write', { path: 'should-not-exist', content: 'a' })).rejects.toThrow('选择工作文件夹')
  tools.setDirectory('relative')
  await expect(run('bash', { command: 'pwd' })).rejects.toThrow('选择工作文件夹')
})

it('reads current UTF-8 text, supports offset/limit and reports EOF and missing paths', async () => {
  const { directory, run } = fixture()
  writeFileSync(join(directory, 'text'), '\ufeff第一行\n第二行\n第三行')
  expect(await run('read', { path: 'text', offset: 2, limit: 1 })).toContain('第二行\n\n[显示第 2–2 行，共 3 行；使用 offset=3')
  expect(await run('read', { path: join(directory, 'text'), offset: 3 })).toBe('第三行')
  await expect(run('read', { path: 'text', offset: 4 })).rejects.toThrow('共 3 行')
  await expect(run('read', { path: 'missing' })).rejects.toThrow('ENOENT')
  await expect(run('read', { path: '.' })).rejects.toThrow('EISDIR')
  writeFileSync(join(directory, 'empty'), '')
  expect(await run('read', { path: 'empty' })).toBe('')
  const homeRelative = `~/${relative(homedir(), join(directory, 'text'))}`
  expect(await run('read', { path: homeRelative, offset: 3 })).toBe('第三行')
})

it('truncates read at 2000 lines and 50 KiB without cutting UTF-8 or hiding the continuation', async () => {
  const { directory, run } = fixture()
  writeFileSync(join(directory, 'lines'), Array.from({ length: 2100 }, (_, index) => `line-${index + 1}`).join('\n'))
  const lines = await run('read', { path: 'lines' }) as string
  expect(lines).toContain('line-2000\n\n[')
  expect(lines).not.toContain('line-2001\n')
  expect(lines).toContain('offset=2001')
  expect(await run('read', { path: 'lines', offset: 2001 })).toContain('line-2100')
  writeFileSync(join(directory, 'bytes'), Array(1000).fill('中文😀'.repeat(20)).join('\n'))
  const bytes = await run('read', { path: 'bytes' }) as string
  expect(Buffer.byteLength(bytes.split('\n\n[')[0])).toBeLessThanOrEqual(50 * 1024)
  expect(bytes).not.toContain('\ufffd')
  expect(bytes).toMatch(/offset=\d+/)
  writeFileSync(join(directory, 'huge-line'), '中'.repeat(20_000))
  expect(await run('read', { path: 'huge-line' })).toContain('第 1 行超过 50 KiB')
})

it('returns image blocks by file signature and rejects invalid UTF-8 and binary edits', async () => {
  const { directory, run } = fixture()
  writeFileSync(join(directory, 'image-without-extension'), png)
  const output = await run('read', { path: 'image-without-extension' }) as ToolOutput
  expect(output.images).toEqual([{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }])
  writeFileSync(join(directory, 'bad'), Buffer.from([0xff, 0xfe]))
  await expect(run('read', { path: 'bad' })).rejects.toThrow('UTF-8')
  writeFileSync(join(directory, 'binary'), Buffer.from([0, 1, 2]))
  await expect(run('edit', { path: 'binary', edits: [{ oldText: 'a', newText: 'b' }] })).rejects.toThrow('二进制')
  expect(readFileSync(join(directory, 'binary'))).toEqual(Buffer.from([0, 1, 2]))
})

it('creates parent directories, completely overwrites and supports empty content', async () => {
  const { directory, run } = fixture()
  const path = join(directory, 'nested', '中文.txt')
  await run('write', { path: 'nested/中文.txt', content: '旧内容' })
  await run('write', { path, content: '新' })
  expect(readFileSync(path, 'utf8')).toBe('新')
  await run('write', { path, content: '' })
  expect(readFileSync(path).length).toBe(0)
})

it('edits disjoint regions against the original, in any order, and preserves BOM/CRLF', async () => {
  const { directory, run } = fixture()
  writeFileSync(join(directory, 'edit'), '\ufeff第一处\r\n不变\r\n第二处\r\n')
  const result = await run('edit', { path: 'edit', edits: [{ oldText: '第二处\n', newText: '第二处更新\n' }, { oldText: '第一处', newText: '第一处更新' }] })
  expect(readFileSync(join(directory, 'edit'), 'utf8')).toBe('\ufeff第一处更新\r\n不变\r\n第二处更新\r\n')
  expect(result).toContain('已替换 2 处')
  expect(result).toContain('-第一处\n+第一处更新')
})

it.each([
  [[{ oldText: 'absent', newText: 'x' }], '未找到'],
  [[{ oldText: '重复', newText: 'x' }], '不唯一'],
  [[{ oldText: 'abcdef', newText: 'x' }, { oldText: 'cde', newText: 'y' }], '重叠'],
  [[{ oldText: 'abcdef', newText: 'abcdef' }], '没有产生变化'],
  [[{ oldText: 'abcdef', newText: 'fresh' }, { oldText: 'fresh', newText: 'x' }], '未找到']
])('does not modify files when any replacement fails (%s)', async (edits, error) => {
  const { directory, run } = fixture()
  const original = '重复\nabcdef\n重复'
  writeFileSync(join(directory, 'edit'), original)
  await expect(run('edit', { path: 'edit', edits })).rejects.toThrow(error)
  expect(readFileSync(join(directory, 'edit'), 'utf8')).toBe(original)
})

it('uses fuzzy matching only where needed and preserves untouched Unicode and whitespace', async () => {
  const { directory, run } = fixture()
  writeFileSync(join(directory, 'edit'), '保留“引号”  \nconst value = “旧”  \n另一行—保留\t\n')
  await run('edit', { path: 'edit', edits: [{ oldText: 'const value = "旧"', newText: 'const value = "新"' }] })
  expect(readFileSync(join(directory, 'edit'), 'utf8')).toBe('保留“引号”  \nconst value = "新"\n另一行—保留\t\n')
  writeFileSync(join(directory, 'edit'), 'value = “重复”\nvalue = "重复"')
  await expect(run('edit', { path: 'edit', edits: [{ oldText: 'value = "重复"', newText: 'new' }] })).rejects.toThrow('不唯一')
})

it('serializes same-path mutations and skips a queued cancelled write', async () => {
  const { directory, run } = fixture()
  const controller = new AbortController()
  const first = run('write', { path: 'edit', content: 'first' })
  const cancelled = run('write', { path: 'edit', content: 'cancelled' }, controller.signal)
  const rejected = expect(cancelled).rejects.toThrow()
  const next = run('edit', { path: 'edit', edits: [{ oldText: 'first', newText: 'last' }] })
  controller.abort()
  await Promise.all([first, rejected, next])
  expect(readFileSync(join(directory, 'edit'), 'utf8')).toBe('last')
})

it('does not create files or start commands for an already aborted signal', async () => {
  const { directory, run } = fixture()
  const controller = new AbortController(); controller.abort()
  await expect(run('write', { path: 'cancelled', content: 'a' }, controller.signal)).rejects.toThrow()
  await expect(run('bash', { command: 'touch cancelled' }, controller.signal)).rejects.toThrow()
  expect(existsSync(join(directory, 'cancelled'))).toBe(false)
})

it('executes bash in the selected cwd, captures both streams and preserves failure output', async () => {
  const { directory, run } = fixture()
  expect(await run('bash', { command: 'pwd; printf "中文😀"; printf "错误输出" >&2' })).toContain(directory)
  await expect(run('bash', { command: 'printf "失败详情" >&2; exit 7' })).rejects.toThrow('失败详情\n\n命令退出码：7')
  expect(await run('bash', { command: 'true' })).toBe('(无输出)')
})

it('retains bounded command tails and readable full logs, then removes its own logs', async () => {
  const { tools, run } = fixture()
  const result = await run('bash', { command: 'for ((i=1;i<=2500;i++)); do printf "line-%s\n" "$i"; done' }) as string
  expect(result).toContain('line-2500')
  expect(result).not.toContain('line-1\n')
  const path = result.match(/完整输出：([^\]]+)/)![1]
  expect(readFileSync(path, 'utf8')).toContain('line-1\n')
  expect(await run('read', { path, offset: 2500, limit: 1 })).toContain('line-2500')
  const bytes = await run('bash', { command: 'for ((i=0;i<20000;i++)); do printf "中文😀"; done' }) as string
  expect(Buffer.byteLength(bytes.split('\n\n[')[0])).toBeLessThanOrEqual(50 * 1024)
  expect(bytes).not.toContain('\ufffd')
  tools.dispose()
  expect(existsSync(path)).toBe(false)
})

it('times out bash and kills descendants on cancellation without allowing later side effects', async () => {
  const { directory, run } = fixture()
  await expect(run('bash', { command: 'printf "before"; sleep 30', timeout: 0.05 })).rejects.toThrow('命令超时')
  const controller = new AbortController()
  const pending = run('bash', { command: '(sleep 1; touch late) & printf "%s" "$!" > child.pid; wait' }, controller.signal)
  const rejected = expect(pending).rejects.toThrow()
  await waitFile(join(directory, 'child.pid'))
  controller.abort()
  await rejected
  const pid = Number(readFileSync(join(directory, 'child.pid'), 'utf8'))
  expect(() => process.kill(pid, 0)).toThrow()
  expect(existsSync(join(directory, 'late'))).toBe(false)
})

it.each<ModelApi>(['openai-completions', 'anthropic-messages'])('runs real file tools and images through the %s loop', async api => {
  const { directory, tools } = fixture()
  writeFileSync(join(directory, 'picture'), png)
  const calls = [
    { id: 'write', name: 'write', arguments: JSON.stringify({ path: 'actual.txt', content: 'original' }) },
    { id: 'read', name: 'read', arguments: JSON.stringify({ path: 'actual.txt' }) },
    { id: 'edit', name: 'edit', arguments: JSON.stringify({ path: 'actual.txt', edits: [{ oldText: 'original', newText: 'changed' }] }) },
    { id: 'bash', name: 'bash', arguments: JSON.stringify({ command: 'cat actual.txt' }) },
    { id: 'image', name: 'read', arguments: JSON.stringify({ path: 'picture' }) },
    { id: 'missing', name: 'read', arguments: JSON.stringify({ path: 'missing' }) }
  ]
  const response = api === 'anthropic-messages' ? anthropicResponse : openAIResponse
  const fetchMock = vi.fn().mockResolvedValueOnce(response('', calls)).mockResolvedValueOnce(response('工具完成'))
  vi.stubGlobal('fetch', fetchMock)
  const agent = createAgent(tools.tools)
  await agent.prompt({ ...config, api }, { role: 'user', content: '操作文件' })
  expect(agent.state.outcome).toBe('complete')
  expect(readFileSync(join(directory, 'actual.txt'), 'utf8')).toBe('changed')
  const results = agent.state.messages.filter(message => message.role === 'toolResult')
  expect(results.map(message => message.isError)).toEqual([false, false, false, false, false, true])
  expect(results[1].content).toBe('original')
  expect(results[3].content).toBe('changed')
  expect(results[5].content).toContain('ENOENT')
  const request = JSON.parse(fetchMock.mock.calls[1][1].body)
  if (api === 'anthropic-messages') {
    expect(request.messages.at(-1).content[4].content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } })
    expect(request.messages.at(-1).content[5].is_error).toBe(true)
  } else {
    expect(request.messages.slice(-7, -1).map((message: { role: string }) => message.role)).toEqual(Array(6).fill('tool'))
    expect(request.messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }] })
  }
})

it('recovers selected directories for followups/retries and clears them on conversation/account changes', async () => {
  const { directory, tools } = fixture()
  const { store, auth, path } = await create()
  const agent = createAgent(tools.tools)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(openAIResponse('已回复')))
  const session = new AgentSession(store, () => {}, agent, tools)
  const attachment = (await readAttachments([directory], 'folder')).attachments[0]
  session.send({ content: '第一问', attachments: [attachment] }, config)
  const id = store.state.activeConversationId!
  await agent.waitForIdle()
  expect(JSON.parse(readFileSync(path, 'utf8')).conversations[0].messages[0].attachments[0].path).toBe(directory)
  session.send({ content: '跟进' }, config); await agent.waitForIdle()
  expect(agent.state.messages[0]).toMatchObject({ role: 'system', content: expect.stringContaining(directory) })
  session.send({ content: '', retry: true }, config); await agent.waitForIdle()
  expect(agent.state.messages[0]).toMatchObject({ content: expect.stringContaining(directory) })
  store.apply({ type: 'conversation:select', id: null })
  session.send({ content: '新会话' }, config); await agent.waitForIdle()
  await expect(tools.tools[0].execute({ path: 'picture' }, new AbortController().signal)).rejects.toThrow('选择工作文件夹')
  store.apply({ type: 'conversation:select', id })
  session.send({ content: '旧附件', attachments: [{ ...attachment, id: 'old', path: undefined }] }, config); await agent.waitForIdle()
  await expect(tools.tools[0].execute({ path: 'picture' }, new AbortController().signal)).rejects.toThrow('选择工作文件夹')
  await auth.logout()
  await auth.register({ username: 'another', password: 'another-password' })
  session.send({ content: '其他账号' }, config); await agent.waitForIdle()
  expect(agent.state.messages[0]).toMatchObject({ content: expect.not.stringContaining(directory) })
})

it('includes the newly selected draft directory in the same token estimate as the real request', async () => {
  const { directory } = fixture()
  const { store } = await create()
  const attachment = (await readAttachments([directory], 'folder')).attachments[0]
  const first = store.begin('旧问题', false, 'test', [attachment])
  first.message.status = 'complete'; first.message.content = '旧答案'
  const replacement = { ...attachment, id: 'replacement', path: directory + '/different-long-directory-name' }
  const estimated = estimateContext(first.conversation, '下一问', [replacement])
  store.begin('下一问', false, 'test', [replacement])
  const actual = contextMessages(first.conversation)
  expect(estimated).toBe(actual.reduce((total, message) => total + Math.ceil(Buffer.byteLength(message.content) / 3) + 4, 3))
})

it('stops real bash through AgentSession and never starts later tool calls', async () => {
  const { directory, tools } = fixture()
  const { store } = await create()
  const agent = createAgent(tools.tools)
  const fetchMock = vi.fn().mockResolvedValue(openAIResponse('', [
    { id: 'long', name: 'bash', arguments: '{"command":"touch ready; sleep 30"}' },
    { id: 'later', name: 'write', arguments: '{"path":"later","content":"bad"}' }
  ]))
  vi.stubGlobal('fetch', fetchMock)
  const session = new AgentSession(store, () => {}, agent, tools)
  session.send({ content: '停止工具', attachments: (await readAttachments([directory], 'folder')).attachments }, config)
  await waitFile(join(directory, 'ready'))
  expect((await session.stop()).conversations[0].messages[1].status).toBe('stopped')
  expect(existsSync(join(directory, 'later'))).toBe(false)
  expect(fetchMock).toHaveBeenCalledOnce()
})

it('returns actionable missing-workspace errors to the model', async () => {
  const { tools } = fixture()
  const fetchMock = vi.fn().mockResolvedValueOnce(openAIResponse('', [{ id: 'call', name: 'read', arguments: '{"path":"missing"}' }])).mockResolvedValueOnce(openAIResponse('请重新选择'))
  vi.stubGlobal('fetch', fetchMock)
  tools.setDirectory()
  const agent = createAgent(tools.tools)
  await agent.prompt(config, { role: 'user', content: '读取' })
  expect(agent.state.messages.find(message => message.role === 'toolResult')).toMatchObject({ isError: true, content: expect.stringContaining('选择工作文件夹') })
  expect(new ToolExecutionError('预期错误')).toBeInstanceOf(Error)
})
