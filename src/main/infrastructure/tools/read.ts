import { readFile } from 'node:fs/promises'
import { ToolExecutionError, type ToolImage } from '../../domain/llm'
import { decodeText, pathSchema, resolveToolPath } from './file-operations'
import { truncateOutput } from './output'
import type { WorkspaceTool } from './tool-runtime'

/** 图片依真实文件头识别，避免将二进制误解码成文本；使用双协议共同支持的格式。 */
function imageType(data: Buffer): ToolImage['mimeType'] | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg'
  if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return undefined
}

/** 独立文件读取工具；声明参数并使用 Node 读取，运行目录由公共执行上下文提供。 */
export const readTool: WorkspaceTool = {
  name: 'read',
  description: 'Read UTF-8 text or PNG/JPEG/GIF/WebP images. Text returns at most 2000 lines or 50 KiB. Use 1-based offset and limit to continue reading.',
  parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: {
    path: pathSchema, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1 }
  } },
  /** 读取当前磁盘内容，文本按行分页；图片经统一结果传到模型适配层。 */
  async execute(args, signal, { cwd }) {
    const data = await readFile(resolveToolPath(args.path as string, cwd), { signal })
    signal.throwIfAborted()
    const mimeType = imageType(data)
    if (mimeType) return { content: `读取图片：${args.path} (${mimeType})`, images: [{ type: 'image', data: data.toString('base64'), mimeType }] }
    const lines = decodeText(data).replace(/^\ufeff/, '').split('\n')
    const start = ((args.offset as number | undefined) || 1) - 1
    if (start >= lines.length) throw new ToolExecutionError(`offset 超出文件末尾，文件共 ${lines.length} 行。`)
    const selected = lines.slice(start, args.limit === undefined ? undefined : start + (args.limit as number)).join('\n')
    const output = truncateOutput(selected)
    if (output.truncated && !output.lines) return `[第 ${start + 1} 行超过 50 KiB，请使用 bash 提取该行的部分内容。]`
    const readLines = output.truncated ? output.lines : Math.min(lines.length - start, (args.limit as number | undefined) ?? lines.length)
    const next = start + readLines + 1
    return output.content + (next <= lines.length ? `\n\n[显示第 ${start + 1}–${next - 1} 行，共 ${lines.length} 行；使用 offset=${next} 继续。]` : '')
  }
}
