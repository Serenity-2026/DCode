/** 文件读取保留开头，命令输出保留结尾；行数与 UTF-8 字节数同时限额。 */
export const maxOutputLines = 2000
export const maxOutputBytes = 50 * 1024

/** 从 UTF-8 字符边界截取尾部，避免中文或 emoji 变成替换字符。 */
export function utf8Tail(data: Buffer, limit: number): Buffer {
  let start = Math.max(0, data.length - limit)
  while (start < data.length && (data[start] & 0xc0) === 0x80) start++
  return data.subarray(start)
}

/** 输出限额内保留完整行；仅命令最后一行超限时允许保留该行尾部。 */
export function truncateOutput(text: string, tail = false): { content: string; lines: number; truncated: boolean } {
  const lines = text ? text.split('\n') : []
  if (text.endsWith('\n')) lines.pop()
  if (lines.length <= maxOutputLines && Buffer.byteLength(text) <= maxOutputBytes) return { content: text, lines: lines.length, truncated: false }
  const selected: string[] = []
  let bytes = 0
  for (const line of tail ? lines.reverse() : lines) {
    const size = Buffer.byteLength(line) + (selected.length ? 1 : 0)
    if (bytes + size > maxOutputBytes) {
      if (tail && !selected.length) selected.push(utf8Tail(Buffer.from(line), maxOutputBytes).toString('utf8'))
      break
    }
    selected.push(line); bytes += size
    if (selected.length === maxOutputLines) break
  }
  return { content: (tail ? selected.reverse() : selected).join('\n'), lines: selected.length, truncated: true }
}
