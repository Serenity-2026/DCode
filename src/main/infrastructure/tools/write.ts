import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { mutateFile, pathSchema, resolveToolPath } from './file-operations'
import type { WorkspaceTool } from './tool-runtime'

/** 独立文件写入工具；创建父目录并完整写入，共用同路径修改队列。 */
export const writeTool: WorkspaceTool = {
  name: 'write',
  description: 'Create or completely overwrite a UTF-8 file. Automatically creates parent directories. Use edit for targeted changes.',
  parameters: { type: 'object', additionalProperties: false, required: ['path', 'content'], properties: {
    path: pathSchema, content: { type: 'string' }
  } },
  /** 新建或完整覆盖文件；创建父目录后再次检查取消，避免取消后启动写入。 */
  async execute(args, signal, { cwd }) {
    const path = resolveToolPath(args.path as string, cwd)
    return mutateFile(path, async () => {
      signal.throwIfAborted()
      await mkdir(dirname(path), { recursive: true })
      signal.throwIfAborted()
      await writeFile(path, args.content as string, 'utf8')
      signal.throwIfAborted()
      return `已写入：${args.path}`
    })
  }
}
