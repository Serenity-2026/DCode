import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { ToolRuntime, type WorkspaceTool } from '../../src/main/infrastructure/tools/tool-runtime'
import { ReadTool } from '../../src/main/infrastructure/tools/read'
import { BashTool } from '../../src/main/infrastructure/tools/bash'
import { EditTool } from '../../src/main/infrastructure/tools/edit'
import { WriteTool } from '../../src/main/infrastructure/tools/write'
import { toolValidator } from '../../src/main/infrastructure/tool-schema'
import { ToolExecutionError } from '../../src/main/domain/llm'
import { AgentSession } from '../../src/main/services/agent-session'
import { readAttachments } from '../../src/main/infrastructure/attachments'
import { anthropicResponse, openAIResponse } from './llm-fixtures'
import { create, createAgent, config, cleanup, taskBoundary } from './helpers'
import type { ModelApi } from '../../src/shared/types'
import { contextMessages, estimateContext } from '../../src/shared/context'

const fixtures: { directory: string; runtime: ToolRuntime }[] = []
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Z9sAAAAASUVORK5CYII=', 'base64')

/** 每个测试仅访问自身临时目录，调用真实生产 handler 和参数校验。 */
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dcode-tools-unit-'))
  const runtime = new ToolRuntime()
  const tools = [new ReadTool(), new BashTool(), new EditTool(), new WriteTool()].map(tool => runtime.bind(tool))
  runtime.setDirectory(directory)
  fixtures.push({ directory, runtime })
  const run = (name: string, args: Record<string, unknown>, signal = new AbortController().signal) => {
    const tool = tools.find(tool => tool.name === name)!
    expect(toolValidator(tool)(args)).toBe(true)
    return tool.execute(args, signal)
  }
  const runText = async (name: string, args: Record<string, unknown>) => (await run(name, args)).content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  return { directory, runtime, tools, run, runText }
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
  for (const { directory, runtime } of fixtures.splice(0)) { runtime.dispose(); rmSync(directory, { recursive: true, force: true }) }
})

it('registers only the four pi tools and rejects malformed arguments without conversion', () => {
  const { tools } = fixture()
  expect(tools.map(tool => tool.name)).toEqual(['read', 'bash', 'edit', 'write'])
  const valid = (name: string, args: unknown) => toolValidator(tools.find(tool => tool.name === name)!)(args)
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

it('injects an independent workspace tool through Agent without changing the runtime or built-in tools', async () => {
  const { directory, runtime } = fixture()
  let temporary: string | undefined
  const custom: WorkspaceTool = {
    name: 'inspect_workspace', description: 'Inspect the current workspace.',
    parameters: { type: 'object', additionalProperties: false, required: ['label'], properties: { label: { type: 'string' } } },
    execute: async (args, signal, { cwd, temporaryDirectories }) => {
      signal.throwIfAborted()
      temporary = mkdtempSync(join(tmpdir(), 'dcode-custom-tool-'))
      temporaryDirectories.add(temporary)
      return { content: [{ type: 'text', text: `${args.label}:${cwd}` }], details: undefined }
    }
  }
  const fetchMock = vi.fn().mockResolvedValueOnce(openAIResponse('', [{ id: 'custom', name: 'inspect_workspace', arguments: '{"label":"自定义"}' }])).mockResolvedValueOnce(openAIResponse('已检查'))
  vi.stubGlobal('fetch', fetchMock)
  const agent = createAgent([runtime.bind(custom)])
  await agent.prompt(config, { role: 'user', content: '检查工作目录' })
  expect(agent.state.outcome).toBe('complete')
  expect(agent.state.tools.map(tool => tool.name)).toEqual(['inspect_workspace'])
  expect(agent.state.messages.find(message => message.role === 'toolResult')).toMatchObject({ content: [{ type: 'text', text: `自定义:${directory}` }], isError: false })
  const request = JSON.parse(fetchMock.mock.calls[0][1].body)
  expect(request.tools[0].function).toMatchObject({ name: custom.name, parameters: custom.parameters })
  expect(request.tools[0].function.execute).toBeUndefined()
  expect(existsSync(temporary!)).toBe(true)
  runtime.dispose()
  expect(existsSync(temporary!)).toBe(false)
})

it('captures cwd at execution time and keeps separately bound runtime contexts isolated', async () => {
  const first = fixture()
  const second = fixture()
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  const custom: WorkspaceTool = {
    name: 'capture', description: 'Capture directory.', parameters: { type: 'object', properties: {} },
    execute: async (_args, _signal, { cwd }) => { await pending; return { content: [{ type: 'text', text: cwd }], details: undefined } }
  }
  const bound = first.runtime.bind(custom)
  const signal = new AbortController().signal
  const running = bound.execute({}, signal)
  first.runtime.setDirectory(second.directory)
  finish()
  expect(await running).toMatchObject({ content: [{ type: 'text', text: first.directory }] })
  expect(await bound.execute({}, signal)).toMatchObject({ content: [{ type: 'text', text: second.directory }] })
  expect(await second.runtime.bind(custom).execute({}, signal)).toMatchObject({ content: [{ type: 'text', text: second.directory }] })
  first.runtime.setDirectory()
  await expect(bound.execute({}, signal)).rejects.toThrow('选择工作文件夹')
  expect(await second.runtime.bind(custom).execute({}, signal)).toMatchObject({ content: [{ type: 'text', text: second.directory }] })
})

it('requires an explicit working directory and never inherits the application cwd', async () => {
  const { runtime, run } = fixture()
  runtime.setDirectory()
  await expect(run('write', { path: 'should-not-exist', content: 'a' })).rejects.toThrow('选择工作文件夹')
  runtime.setDirectory('relative')
  await expect(run('bash', { command: 'pwd' })).rejects.toThrow('选择工作文件夹')
})

it('reads current UTF-8 text, supports offset/limit and reports EOF and missing paths', async () => {
  const { directory, run, runText } = fixture()
  writeFileSync(join(directory, 'text'), '\ufeff第一行\n第二行\n第三行')
  const page = await run('read', { path: 'text', offset: 2, limit: 1 })
  expect(page).toMatchObject({ content: [{ type: 'text', text: expect.stringContaining('第二行\n\n[显示第 2–2 行，共 3 行；使用 offset=3') }], details: { totalLines: 3, nextOffset: 3 } })
  expect(await runText('read', { path: join(directory, 'text'), offset: 3 })).toBe('第三行')
  await expect(run('read', { path: 'text', offset: 4 })).rejects.toThrow('共 3 行')
  await expect(run('read', { path: 'missing' })).rejects.toThrow('ENOENT')
  await expect(run('read', { path: '.' })).rejects.toThrow('EISDIR')
  writeFileSync(join(directory, 'empty'), '')
  expect(await runText('read', { path: 'empty' })).toBe('')
  const homeRelative = `~/${relative(homedir(), join(directory, 'text'))}`
  expect(await runText('read', { path: homeRelative, offset: 3 })).toBe('第三行')
})

it('truncates read at 2000 lines and 50 KiB without cutting UTF-8 or hiding the continuation', async () => {
  const { directory, run, runText } = fixture()
  writeFileSync(join(directory, 'lines'), Array.from({ length: 2100 }, (_, index) => `line-${index + 1}`).join('\n'))
  expect((await run('read', { path: 'lines' })).details).toEqual({ totalLines: 2100, nextOffset: 2001, truncation: { lines: 2000, bytes: expect.any(Number) } })
  const lines = await runText('read', { path: 'lines' })
  expect(lines).toContain('line-2000\n\n[')
  expect(lines).not.toContain('line-2001\n')
  expect(lines).toContain('offset=2001')
  expect(await runText('read', { path: 'lines', offset: 2001 })).toContain('line-2100')
  writeFileSync(join(directory, 'bytes'), Array(1000).fill('中文😀'.repeat(20)).join('\n'))
  const bytes = await runText('read', { path: 'bytes' })
  expect(Buffer.byteLength(bytes.split('\n\n[')[0])).toBeLessThanOrEqual(50 * 1024)
  expect(bytes).not.toContain('\ufffd')
  expect(bytes).toMatch(/offset=\d+/)
  writeFileSync(join(directory, 'huge-line'), '中'.repeat(20_000))
  expect(await runText('read', { path: 'huge-line' })).toContain('第 1 行超过 50 KiB')
})

it('returns image blocks by file signature and rejects invalid UTF-8 and binary edits', async () => {
  const { directory, run } = fixture()
  writeFileSync(join(directory, 'image-without-extension'), png)
  const output = await run('read', { path: 'image-without-extension' })
  expect(output.content.filter(block => block.type === 'image')).toEqual([{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }])
  writeFileSync(join(directory, 'bad'), Buffer.from([0xff, 0xfe]))
  await expect(run('read', { path: 'bad' })).rejects.toThrow('UTF-8')
  writeFileSync(join(directory, 'binary'), Buffer.from([0, 1, 2]))
  await expect(run('edit', { path: 'binary', edits: [{ oldText: 'a', newText: 'b' }] })).rejects.toThrow('二进制')
  expect(readFileSync(join(directory, 'binary'))).toEqual(Buffer.from([0, 1, 2]))
})

it('creates parent directories, completely overwrites and supports empty content', async () => {
  const { directory, run } = fixture()
  const path = join(directory, 'nested', '中文.txt')
  expect(await run('write', { path: 'nested/中文.txt', content: '旧内容' })).toEqual({ content: [{ type: 'text', text: '已写入：nested/中文.txt' }], details: undefined })
  await run('write', { path, content: '新' })
  expect(readFileSync(path, 'utf8')).toBe('新')
  await run('write', { path, content: '' })
  expect(readFileSync(path).length).toBe(0)
})

it('edits disjoint regions against the original, in any order, and preserves BOM/CRLF', async () => {
  const { directory, run } = fixture()
  writeFileSync(join(directory, 'edit'), '\ufeff第一处\r\n不变\r\n第二处\r\n')
  const output = await run('edit', { path: 'edit', edits: [{ oldText: '第二处\n', newText: '第二处更新\n' }, { oldText: '第一处', newText: '第一处更新' }] })
  const result = output.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  expect(output.details).toEqual({ diff: expect.stringContaining('-第一处\n+第一处更新') })
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
  const { directory, run, runText } = fixture()
  expect(await runText('bash', { command: 'pwd; printf "中文😀"; printf "错误输出" >&2' })).toContain(directory)
  expect(await run('bash', { command: 'printf "失败详情" >&2; exit 7' })).toMatchObject({ content: [{ type: 'text', text: '失败详情\n\n命令退出码：7。' }], details: { exitCode: 7, timedOut: false }, isError: true })
  expect(await runText('bash', { command: 'true' })).toBe('(无输出)')
})

it('retains bounded command tails and readable full logs, then removes its own logs', async () => {
  const { runtime, runText } = fixture()
  const result = await runText('bash', { command: 'for ((i=1;i<=2500;i++)); do printf "line-%s\n" "$i"; done' })
  expect(result).toContain('line-2500')
  expect(result).not.toContain('line-1\n')
  const path = result.match(/完整输出：([^\]]+)/)![1]
  expect(readFileSync(path, 'utf8')).toContain('line-1\n')
  expect(await runText('read', { path, offset: 2500, limit: 1 })).toContain('line-2500')
  const bytes = await runText('bash', { command: 'for ((i=0;i<20000;i++)); do printf "中文😀"; done' })
  expect(Buffer.byteLength(bytes.split('\n\n[')[0])).toBeLessThanOrEqual(50 * 1024)
  expect(bytes).not.toContain('\ufffd')
  runtime.dispose()
  expect(existsSync(path)).toBe(false)
})

it('keeps structured log details when a truncated bash command fails', async () => {
  const { run } = fixture()
  const output = await run('bash', { command: 'for ((i=1;i<=2500;i++)); do printf "line-%s\n" "$i"; done; exit 7' })
  expect(output).toMatchObject({ details: { exitCode: 7, timedOut: false, truncation: { lines: 2000, bytes: expect.any(Number) }, fullOutputPath: expect.any(String) }, isError: true })
  const path = (output.details as { fullOutputPath: string }).fullOutputPath
  expect(readFileSync(path, 'utf8')).toContain('line-1\n')
  expect(output.content).toEqual([{ type: 'text', text: expect.stringContaining(`完整输出：${path}`) }])
})

it('times out bash and kills descendants on cancellation without allowing later side effects', async () => {
  const { directory, run } = fixture()
  expect(await run('bash', { command: 'printf "before"; sleep 30', timeout: 0.05 })).toMatchObject({ content: [{ type: 'text', text: expect.stringContaining('命令超时') }], details: { timedOut: true }, isError: true })
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
  const agent = createAgent(tools)
  await agent.prompt({ ...config, api }, { role: 'user', content: '操作文件' })
  expect(agent.state.outcome).toBe('complete')
  expect(readFileSync(join(directory, 'actual.txt'), 'utf8')).toBe('changed')
  const results = agent.state.messages.filter(message => message.role === 'toolResult')
  expect(results.map(message => message.isError)).toEqual([false, false, false, false, false, true])
  expect(results[1].content).toEqual([{ type: 'text', text: 'original' }])
  expect(results[3].content).toEqual([{ type: 'text', text: 'changed' }])
  expect(results[5].content).toEqual([{ type: 'text', text: expect.stringContaining('ENOENT') }])
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
  const { directory, runtime, tools } = fixture()
  const { store, auth, path } = await create()
  const agent = createAgent(tools)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(openAIResponse('已回复')))
  const session = new AgentSession(store, () => {}, agent, taskBoundary(), runtime)
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
  await expect(tools[0].execute({ path: 'picture' }, new AbortController().signal)).rejects.toThrow('选择工作文件夹')
  store.apply({ type: 'conversation:select', id })
  session.send({ content: '旧附件', attachments: [{ ...attachment, id: 'old', path: undefined }] }, config); await agent.waitForIdle()
  await expect(tools[0].execute({ path: 'picture' }, new AbortController().signal)).rejects.toThrow('选择工作文件夹')
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
  const { directory, runtime, tools } = fixture()
  const { store } = await create()
  const agent = createAgent(tools)
  const fetchMock = vi.fn().mockResolvedValue(openAIResponse('', [
    { id: 'long', name: 'bash', arguments: '{"command":"touch ready; sleep 30"}' },
    { id: 'later', name: 'write', arguments: '{"path":"later","content":"bad"}' }
  ]))
  vi.stubGlobal('fetch', fetchMock)
  const session = new AgentSession(store, () => {}, agent, taskBoundary(), runtime)
  session.send({ content: '停止工具', attachments: (await readAttachments([directory], 'folder')).attachments }, config)
  await waitFile(join(directory, 'ready'))
  expect((await session.stop()).conversations[0].messages[1].status).toBe('stopped')
  expect(existsSync(join(directory, 'later'))).toBe(false)
  expect(fetchMock).toHaveBeenCalledOnce()
})

it('returns actionable missing-workspace errors to the model', async () => {
  const { runtime, tools } = fixture()
  const fetchMock = vi.fn().mockResolvedValueOnce(openAIResponse('', [{ id: 'call', name: 'read', arguments: '{"path":"missing"}' }])).mockResolvedValueOnce(openAIResponse('请重新选择'))
  vi.stubGlobal('fetch', fetchMock)
  runtime.setDirectory()
  const agent = createAgent(tools)
  await agent.prompt(config, { role: 'user', content: '读取' })
  expect(agent.state.messages.find(message => message.role === 'toolResult')).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('选择工作文件夹') }] })
  expect(new ToolExecutionError('预期错误')).toBeInstanceOf(Error)
})
