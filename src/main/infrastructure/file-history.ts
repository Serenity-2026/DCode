import { lstat, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { formatPatch, structuredPatch } from 'diff'
import type { FileChange } from '../../shared/types'
import { createFilePreview } from './tools/output'
import { mutateFile } from './tools/file-operations'

/** 文本转为完整字节副本；空文本与不存在的文件保持不同。 */
export function fileBytes(text: string | null): string | null { return text === null ? null : Buffer.from(text, 'utf8').toString('base64') }

/** {
 content: '当前文件内容的 Base64 编码',
 parentDirectory: '真实父目录路径',
 mode: 文件权限
 } */
export async function fileVersion(path: string, expectedParent?: string): Promise<{ content: string | null; parentDirectory: string; mode?: number }> {
  const parentDirectory = await realpath(dirname(path))
  if (expectedParent && parentDirectory !== expectedParent) throw new Error('文件所在目录已变化，无法撤销。')
  const info = await lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (!info) return { content: null, parentDirectory }
  if (!info.isFile() || info.nlink !== 1) throw new Error('链接或特殊文件不支持撤销记录。')
  const content = (await readFile(path)).toString('base64')
  const after = await lstat(path)
  if (after.ino !== info.ino || after.dev !== info.dev || after.mtimeMs !== info.mtimeMs || after.size !== info.size || after.nlink !== 1) throw new Error('读取期间文件已变化，请重试。')
  return { content, parentDirectory, mode: info.mode & 0o777 }
}

/**
 * additions: 增加的行数,
 * deletions: 删除的行数,
 * preview: 内容和差异预览
  */
export function describeChange(path: string, before: string | null, after: string | null): Pick<FileChange, 'additions' | 'deletions' | 'preview'> {
  const oldText = before === null ? '' : Buffer.from(before, 'base64').toString('utf8')
  const newText = after === null ? '' : Buffer.from(after, 'base64').toString('utf8')
  const patch = structuredPatch(path, path, oldText, newText, undefined, undefined, { context: 3 })
  const lines = patch.hunks.flatMap(hunk => hunk.lines)
  return {
    additions: lines.filter(line => line.startsWith('+')).length,
    deletions: lines.filter(line => line.startsWith('-')).length,
    preview: createFilePreview(newText, formatPatch(patch))
  }
}

/** 工作区内显示相对路径，目录外仍显示完整路径，不依赖 renderer 的 Node 能力。 */
export function displayFilePath(path: string, directory: string): string {
  const name = relative(directory, path)
  return name && name !== '..' && !name.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ? name : path
}

/** 按固定顺序取得整批路径队列，避免整轮恢复与其他应用内写入交错或死锁。
 * paths：文件路径
 * operation：撤销步骤
 * lock是一个递归函数：
 * 还有文件没有处理，就先进入当前文件的操作队列。
 * 轮到当前操作后，再继续处理下一个文件。
 * 所有文件都已经取得执行机会，才调用真正的 operation()。
 * */
export function withFileChanges<T>(paths: string[], operation: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(paths)].sort()
  const lock = (index: number):
      Promise<T> => index === ordered.length ?
      operation() :
      mutateFile(ordered[index], () => lock(index + 1))
  return lock(0)
}

/** 原子替换已有文本，或删除本轮新建文件；落盘前再次检查当前内容及父目录。
 * 把 before 从 Base64 解码
 *     ↓
 * 写入同目录的临时文件
 *     ↓
 * 再次核对目标文件内容
 *     ↓
 * rename 临时文件，替换目标文件.使用完整副本恢复，不是根据 diff 反向修改。
 *
 * */
export async function restoreFile(path: string, parent: string, before: string | null, after: string | null): Promise<void> {
  const current = await fileVersion(path, parent)
  if (current.content === before) return
  if (current.content !== after) throw new Error(`文件已被后续修改，无法撤销：${path}`)
  if (before === null) {
    await unlink(path);
    return
  }
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.undo`)
  try {
    await writeFile(temporary, Buffer.from(before, 'base64'), { flag: 'wx', mode: current.mode })
    if ((await fileVersion(path, parent)).content !== after) throw new Error(`文件已被后续修改，无法撤销：${path}`)
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }) }
}
