import { createTwoFilesPatch } from 'diff'
import { ToolExecutionError } from '../../domain/llm'
import { truncateOutput } from './output'

export interface TextEdit { oldText: string; newText: string }
interface Replacement { start: number; end: number; text: string }

/** 匹配前统一换行，最终由调用方恢复文件原有换行格式。 */
function lf(text: string): string { return text.replace(/\r\n?/g, '\n') }

/** 参考 pi 的容错规则；只在精确匹配失败时处理尾部空白与 Unicode 标点。 */
function fuzzy(text: string): string {
  return text.normalize('NFKC').split('\n').map(line => line.trimEnd()).join('\n')
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'").replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, ' ')
}

/** 所有替换先匹配同一原文，检测缺失、歧义和重叠后再从尾部应用。 */
function replacements(base: string, edits: TextEdit[]): Replacement[] {
  const found = edits.map((edit, index) => {
    const needle = base.includes(edit.oldText) ? edit.oldText : fuzzy(edit.oldText)
    if (!needle) throw new ToolExecutionError(`edits[${index}].oldText 不能为空。`)
    const start = base.indexOf(needle)
    if (start < 0) throw new ToolExecutionError(`未找到 edits[${index}].oldText，请重新 read 文件后提供准确原文。`)
    const normalizedNeedle = fuzzy(needle)
    const normalizedBase = fuzzy(base)
    const first = normalizedBase.indexOf(normalizedNeedle)
    if (!normalizedNeedle || normalizedBase.indexOf(normalizedNeedle, first + 1) >= 0) throw new ToolExecutionError(`edits[${index}].oldText 不唯一，请提供更多上下文。`)
    return { start, end: start + needle.length, text: edit.newText }
  }).sort((a, b) => a.start - b.start)
  for (let index = 1; index < found.length; index++) if (found[index - 1].end > found[index].start) throw new ToolExecutionError('替换区域重叠，请合并或选择不重叠的区域。')
  return found
}

/** 从末尾替换，避免之前的替换改变之后的坐标。 */
function apply(base: string, found: Replacement[], offset = 0): string {
  for (const item of [...found].reverse()) base = base.slice(0, item.start - offset) + item.text + base.slice(item.end - offset)
  return base
}

/** 容错仅重写被替换实际触及的行，其余行保留原始空白与 Unicode 字符。 */
function preserveLines(original: string, base: string, found: Replacement[]): string {
  const originalLines = original.match(/[^\n]*\n|[^\n]+/g) || []
  const baseLines = base.match(/[^\n]*\n|[^\n]+/g) || []
  let position = 0
  const spans = baseLines.map(line => { const start = position; position += line.length; return { start, end: position } })
  const groups: { first: number; last: number; edits: Replacement[] }[] = []
  for (const item of found) {
    const first = spans.findIndex(line => item.start >= line.start && item.start < line.end)
    let last = first
    while (spans[last].end < item.end) last++
    const previous = groups.at(-1)
    if (previous && first <= previous.last) { previous.last = Math.max(previous.last, last); previous.edits.push(item) }
    else groups.push({ first, last, edits: [item] })
  }
  let result = ''
  let next = 0
  for (const group of groups) {
    result += originalLines.slice(next, group.first).join('')
    result += apply(baseLines.slice(group.first, group.last + 1).join(''), group.edits, spans[group.first].start)
    next = group.last + 1
  }
  return result + originalLines.slice(next).join('')
}

/** 纯文本编辑计算，不访问磁盘；成功时返回保留 BOM/换行的内容及有界差异。 */
export function editText(raw: string, edits: TextEdit[], path: string): { content: string; diff: string } {
  const bom = raw.startsWith('\ufeff') ? '\ufeff' : ''
  const original = lf(raw.slice(bom.length))
  const normalized = edits.map(edit => ({ oldText: lf(edit.oldText), newText: lf(edit.newText) }))
  if (normalized.some(edit => !edit.oldText)) throw new ToolExecutionError('oldText 不能为空。')
  const usesFuzzy = normalized.some(edit => !original.includes(edit.oldText))
  const base = usesFuzzy ? fuzzy(original) : original
  const found = replacements(base, normalized)
  const changed = usesFuzzy ? preserveLines(original, base, found) : apply(base, found)
  if (changed === original) throw new ToolExecutionError('替换没有产生变化。')
  const diff = truncateOutput(createTwoFilesPatch(path, path, original, changed, undefined, undefined, { context: 3 }))
  const crlf = raw.indexOf('\r\n') >= 0 && raw.indexOf('\r\n') < raw.indexOf('\n')
  return { content: bom + (crlf ? changed.replace(/\n/g, '\r\n') : changed), diff: diff.content + (diff.truncated ? '\n[差异已截断，请 read 文件检查完整内容。]' : '') }
}
