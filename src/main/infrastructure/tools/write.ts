import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createTwoFilesPatch } from 'diff'
import { ToolExecutionError, type AgentToolResult } from '../../domain/llm'
import { decodeText, mutateFile, pathSchema, resolveToolPath } from './file-operations'
import { createFilePreview } from './output'
import type { FilePreview } from '../../../shared/types'
import type { ToolExecutionContext, WorkspaceTool } from './tool-runtime'

/** 写入后文本与实际写入前内容的差异，供文件面板展示。 */
export interface WriteToolDetails { preview: FilePreview }

/** 独立文件写入工具；创建父目录并完整写入，共用同路径修改队列。 */
export class WriteTool implements WorkspaceTool<WriteToolDetails> {
  readonly name = 'write'
  readonly executionMode = 'sequential'
  readonly description = 'Create or completely overwrite a UTF-8 file. Before overwriting an existing file, read it with read; if its modification time changes, read it again. New files do not require read. Automatically creates parent directories. Use edit for targeted changes.'
  readonly parameters = { type: 'object', additionalProperties: false, required: ['path', 'content'], properties: {
    path: pathSchema, content: { type: 'string' }
  } }
  /** 覆盖前校验已读时间；新建使用独占创建，避免检查后出现的文件被覆盖。 */
  async execute(args: Record<string, unknown>, signal: AbortSignal, { cwd, readFileState }: ToolExecutionContext): Promise<AgentToolResult<WriteToolDetails>> {
    const path = resolveToolPath(args.path as string, cwd)
    return mutateFile(path, async () => {
      signal.throwIfAborted()
      await mkdir(dirname(path), { recursive: true })
      const current = await stat(path).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      })
      if (current) {
        const timestamp = readFileState.get(path)
        if (timestamp === undefined) throw new ToolExecutionError('请先使用 read 读取该文件，再使用 write 覆盖。')
        if (current.mtimeMs !== timestamp) throw new ToolExecutionError('文件修改时间已变化，请重新使用 read 读取后再覆盖。')
      }
      const before = current ? decodeText(await readFile(path, { signal })) : ''
      if (current && (await stat(path)).mtimeMs !== current.mtimeMs) throw new ToolExecutionError('文件修改时间已变化，请重新使用 read 读取后再覆盖。')
      signal.throwIfAborted()
      readFileState.delete(path)
      try { await writeFile(path, args.content as string, { encoding: 'utf8', flag: current ? 'w' : 'wx' }) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ToolExecutionError('文件已存在，请先使用 read 读取该文件，再使用 write 覆盖。')
        throw error
      }
      const updatedTimestamp = current ? (await stat(path)).mtimeMs : undefined
      signal.throwIfAborted()
      if (updatedTimestamp !== undefined) readFileState.set(path, updatedTimestamp)
      const content = args.content as string
      const diff = createTwoFilesPatch(args.path as string, args.path as string, before, content, undefined, undefined, { context: 3 })
      return { content: [{ type: 'text', text: `已写入：${args.path}` }], details: { preview: createFilePreview(content, diff) } }
    })
  }
}
