import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { ToolExecutionError, type AgentTool, type ToolImage, type ToolOutput, type ToolWorkspace } from '../../domain/llm'
import { editText, type TextEdit } from './edit'
import { runBash } from './bash'
import { truncateOutput } from './output'

const pathSchema = { type: 'string', minLength: 1, description: 'File path, relative to the working directory, absolute, or ~/.' }
const mutations = new Map<string, Promise<unknown>>()

/** 按绝对路径串行写入；取消不会在旧磁盘操作尚未结束时释放互斥。 */
async function mutate<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutations.get(path) || Promise.resolve()
  const current = previous.catch(() => {}).then(operation)
  mutations.set(path, current)
  try { return await current }
  finally { if (mutations.get(path) === current) mutations.delete(path) }
}

/** 图片依真实文件头识别，避免将二进制误解码成文本；沿用双协议共同支持的格式。 */
function imageType(data: Buffer): ToolImage['mimeType'] | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg'
  if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return undefined
}

/** 严格读取 UTF-8 并保留 BOM；edit 不允许对二进制或畸形编码执行替换。 */
function decode(data: Buffer): string {
  if (data.includes(0)) throw new ToolExecutionError('文件是二进制内容，不能作为 UTF-8 文本操作。')
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data) }
  catch { throw new ToolExecutionError('文件不是有效 UTF-8 文本。') }
}

/** 主进程本机编码工具；依赖 Node 磁盘/进程能力，工作目录由会话在每次发送前配置。 */
export class CodingTools implements ToolWorkspace {
  readonly tools: AgentTool[]
  private directory?: string
  private readonly logs = new Set<string>()

  /** 构造可信工具声明，Agent 启动时编译 Schema；不读取应用账号或存储。 */
  constructor() {
    this.tools = [
      this.tool('read', 'Read UTF-8 text or PNG/JPEG/GIF/WebP images. Text returns at most 2000 lines or 50 KiB. Use 1-based offset and limit to continue reading.', {
        path: pathSchema, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1 }
      }, ['path'], (args, signal, cwd) => this.read(args, signal, cwd)),
      this.tool('bash', 'Execute a bash command in the working directory. Returns stdout/stderr, keeping the last 2000 lines or 50 KiB. Truncated output is saved to a temporary file. Optional timeout in seconds; no default timeout.', {
        command: { type: 'string', minLength: 1 }, timeout: { type: 'number', exclusiveMinimum: 0, maximum: 2_147_483.647 }
      }, ['command'], (args, signal, cwd) => runBash(args.command as string, cwd, args.timeout as number | undefined, signal, this.logs)),
      this.tool('edit', 'Edit one UTF-8 file using edits: [{oldText, newText}]. Each oldText must identify a unique, non-overlapping region of the original file. All replacements are validated before writing. Returns a unified diff.', {
        path: pathSchema, edits: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['oldText', 'newText'], properties: { oldText: { type: 'string', minLength: 1 }, newText: { type: 'string' } } } }
      }, ['path', 'edits'], (args, signal, cwd) => this.edit(args, signal, cwd)),
      this.tool('write', 'Create or completely overwrite a UTF-8 file. Automatically creates parent directories. Use edit for targeted changes.', {
        path: pathSchema, content: { type: 'string' }
      }, ['path', 'content'], (args, signal, cwd) => this.write(args, signal, cwd))
    ]
  }

  /** 空目录选择清除上次会话目录；非法路径在执行时形成可处理的工具错误。 */
  setDirectory(directory?: string): void { this.directory = directory }

  /** 应用退出时删除仅由本工具创建的完整输出日志，不触及用户目录。 */
  dispose(): void {
    for (const directory of this.logs) rmSync(directory, { recursive: true, force: true })
    this.logs.clear()
  }

  /** 为四个 handler 统一固定本次 cwd、观察取消并转换预期文件系统错误。 */
  private tool(name: string, description: string, properties: Record<string, unknown>, required: string[], execute: (args: Record<string, unknown>, signal: AbortSignal, cwd: string) => Promise<string | ToolOutput>): AgentTool {
    return { name, description, parameters: { type: 'object', additionalProperties: false, required, properties }, execute: async (args, signal) => {
      signal.throwIfAborted()
      const cwd = this.directory
      if (!cwd || !isAbsolute(cwd)) throw new ToolExecutionError('请先选择工作文件夹。旧附件没有目录路径时需要重新选择。')
      try { return await execute(args, signal, cwd) }
      catch (error) {
        signal.throwIfAborted()
        const code = (error as NodeJS.ErrnoException)?.code
        if (['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'ENOSPC', 'EROFS'].includes(code || '')) throw new ToolExecutionError(`文件操作失败（${code}），请检查路径、权限或磁盘空间。`)
        throw error
      }
    } }
  }

  /** 使用选定目录解析相对路径，支持绝对路径与用户主目录。 */
  private path(value: string, cwd: string): string {
    if (!value.trim() || value.includes('\0')) throw new ToolExecutionError('文件路径无效。')
    return resolve(cwd, value === '~' ? homedir() : value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : value)
  }

  /** 读取当前磁盘内容，文本按行分页；图片经统一结果传到模型适配层。 */
  private async read(args: Record<string, unknown>, signal: AbortSignal, cwd: string): Promise<string | ToolOutput> {
    const data = await readFile(this.path(args.path as string, cwd), { signal })
    signal.throwIfAborted()
    const mimeType = imageType(data)
    if (mimeType) return { content: `读取图片：${args.path} (${mimeType})`, images: [{ type: 'image', data: data.toString('base64'), mimeType }] }
    const lines = decode(data).replace(/^\ufeff/, '').split('\n')
    const start = ((args.offset as number | undefined) || 1) - 1
    if (start >= lines.length) throw new ToolExecutionError(`offset 超出文件末尾，文件共 ${lines.length} 行。`)
    const selected = lines.slice(start, args.limit === undefined ? undefined : start + (args.limit as number)).join('\n')
    const output = truncateOutput(selected)
    if (output.truncated && !output.lines) return `[第 ${start + 1} 行超过 50 KiB，请使用 bash 提取该行的部分内容。]`
    const readLines = output.truncated ? output.lines : Math.min(lines.length - start, (args.limit as number | undefined) ?? lines.length)
    const next = start + readLines + 1
    return output.content + (next <= lines.length ? `\n\n[显示第 ${start + 1}–${next - 1} 行，共 ${lines.length} 行；使用 offset=${next} 继续。]` : '')
  }

  /** 统一验证所有替换后写入，队列在底层操作完成前持续持有路径锁。 */
  private async edit(args: Record<string, unknown>, signal: AbortSignal, cwd: string): Promise<string> {
    const path = this.path(args.path as string, cwd)
    return mutate(path, async () => {
      signal.throwIfAborted()
      const data = await readFile(path, { signal })
      signal.throwIfAborted()
      const changed = editText(decode(data), args.edits as TextEdit[], args.path as string)
      signal.throwIfAborted()
      await writeFile(path, changed.content, 'utf8')
      signal.throwIfAborted()
      return `已替换 ${(args.edits as TextEdit[]).length} 处：${args.path}\n${changed.diff}`
    })
  }

  /** 新建或完整覆盖文件；创建父目录后再次检查取消，避免取消后启动写入。 */
  private async write(args: Record<string, unknown>, signal: AbortSignal, cwd: string): Promise<string> {
    const path = this.path(args.path as string, cwd)
    return mutate(path, async () => {
      signal.throwIfAborted()
      await mkdir(dirname(path), { recursive: true })
      signal.throwIfAborted()
      await writeFile(path, args.content as string, 'utf8')
      signal.throwIfAborted()
      return `已写入：${args.path}`
    })
  }
}
