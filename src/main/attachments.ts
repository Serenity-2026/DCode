import { randomUUID } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import type { Attachment, AttachmentSelection } from '../shared/types'
import { attachmentByteLimit, validateAttachments } from '../shared/context'

/** 读取系统选择器返回的路径，供主进程附件 IPC 使用；不会执行文件或跟随目录符号链接。 */
export async function readAttachments(paths: string[], kind: 'file' | 'folder'): Promise<AttachmentSelection> {
  const attachments: Attachment[] = []
  let skipped = 0
  let files = 0
  let bytes = 0
  let visited = 0
  for (const selected of paths) {
    const parts: string[] = []
    let fileCount = 0
    /** 递归读取已选根目录下的文本，限制遍历与文本总量；目录读取失败让本次选择整体失败。 */
    async function visit(path: string): Promise<void> {
      if (++visited > 10_000) throw new Error('目录项目过多，请选择更小的文件夹。')
      const info = await lstat(path)
      if (info.isSymbolicLink()) { skipped++; return }
      if (info.isDirectory()) {
        if (kind !== 'folder') throw new Error('请选择文件。')
        const entries = await readdir(path, { withFileTypes: true })
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.name.startsWith('.') || ['node_modules', 'dist', 'out', 'release', 'build'].includes(entry.name)) { skipped++; continue }
          await visit(join(path, entry.name))
        }
        return
      }
      if (!info.isFile() || !info.size || info.size > 128 * 1024) { skipped++; return }
      const data = await readFile(path)
      if (data.length > 128 * 1024 || data.includes(0)) { skipped++; return }
      let text: string
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(data) }
      catch { skipped++; return }
      if (!text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) { skipped++; return }
      if (++files > 50) throw new Error('一次最多添加 50 个文本文件，请缩小选择范围。')
      const label = kind === 'folder' ? relative(selected, path) : basename(path)
      const part = `--- ${label} ---\n${text}`
      bytes += Buffer.byteLength(part, 'utf8') + 2
      if (bytes > attachmentByteLimit) throw new Error('附件文本总计不能超过 512 KiB，请减少文件。')
      fileCount++; parts.push(part)
    }
    try {
      const root = await lstat(selected)
      if (kind === 'folder' && !root.isDirectory() && !root.isSymbolicLink()) throw new Error('请选择文件夹。')
      await visit(selected)
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) throw new Error(`无法读取“${basename(selected)}”，请检查文件是否存在及访问权限。`)
      throw error
    }
    if (fileCount) attachments.push({ id: randomUUID(), name: basename(selected), kind, fileCount, content: parts.join('\n\n') })
  }
  validateAttachments(attachments)
  return { attachments, skipped }
}
