import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { ToolExecutionError } from '../../domain/llm'

export const pathSchema = { type: 'string', minLength: 1, description: 'File path, relative to the working directory, absolute, or ~/.' }
const mutations = new Map<string, Promise<unknown>>()

/** 按绝对路径串行写入；取消不会在旧磁盘操作尚未结束时释放互斥。 */
export async function mutateFile<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutations.get(path) || Promise.resolve()
  const current = previous.catch(() => {}).then(operation)
  mutations.set(path, current)
  try { return await current }
  finally { if (mutations.get(path) === current) mutations.delete(path) }
}

/** 严格读取 UTF-8 并保留 BOM；二进制和畸形编码不得执行文本替换。 */
export function decodeText(data: Buffer): string {
  if (data.includes(0)) throw new ToolExecutionError('文件是二进制内容，不能作为 UTF-8 文本操作。')
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data) }
  catch { throw new ToolExecutionError('文件不是有效 UTF-8 文本。') }
}

/** 使用选定目录解析相对路径，支持绝对路径与用户主目录。 */
export function resolveToolPath(value: string, cwd: string): string {
  if (!value.trim() || value.includes('\0')) throw new ToolExecutionError('文件路径无效。')
  return resolve(cwd, value === '~' ? homedir() : value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : value)
}
