import { contextMessages } from '../../src/shared/context'
import { StateRepository } from '../../src/main/repositories/state-repository'
import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readAttachments } from '../../src/main/infrastructure/attachments'
import { StateService } from '../../src/main/services/state-service'
import { attachmentByteLimit, estimateContext, validateAttachments } from '../../src/shared/context'
import type { Attachment } from '../../src/shared/types'
import { create, cleanup } from './helpers'

const folders: string[] = []
/** 创建只属于本测试的磁盘附件，afterEach 同时清理账号数据与文件。 */
function fixture(): string { const folder = mkdtempSync(join(tmpdir(), 'dcode-attachment-unit-')); folders.push(folder); return folder }
afterEach(() => { cleanup(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })

it('reads a selected UTF-8 file and preserves its name and original text', async () => {
  const folder = fixture()
  const path = join(folder, '代码.ts')
  writeFileSync(path, 'export const 中文 = "你好"')
  const result = await readAttachments([path], 'file')
  expect(result.skipped).toBe(0)
  expect(result.attachments[0]).toMatchObject({ name: '代码.ts', kind: 'file', fileCount: 1 })
  expect(result.attachments[0].content).toContain('export const 中文 = "你好"')
  expect(result.attachments[0].content).not.toContain(folder)
})

it('collects folder text while skipping hidden files, dependencies, binary data and symlinks', async () => {
  const folder = fixture()
  mkdirSync(join(folder, 'src')); mkdirSync(join(folder, 'node_modules'))
  writeFileSync(join(folder, 'src', 'index.ts'), 'export const answer = 42')
  writeFileSync(join(folder, '.env'), 'excluded-key')
  writeFileSync(join(folder, 'node_modules', 'vendor.js'), 'excluded-vendor')
  writeFileSync(join(folder, 'image.bin'), Buffer.from([0, 1, 2]))
  writeFileSync(join(folder, 'invalid.txt'), Buffer.from([0xff, 0xfe]))
  symlinkSync(join(folder, 'src'), join(folder, 'linked-src'))
  const result = await readAttachments([folder], 'folder')
  expect(result.attachments[0].fileCount).toBe(1)
  expect(result.attachments[0].content).toContain('src/index.ts')
  expect(result.attachments[0].content).not.toContain('excluded-')
  expect(result.skipped).toBe(5)
})

it('reports non-text selections and rejects file count and combined size overflow', async () => {
  const folder = fixture()
  const oversized = join(folder, 'large.txt')
  writeFileSync(oversized, 'a'.repeat(128 * 1024 + 1))
  expect(await readAttachments([oversized], 'file')).toEqual({ attachments: [], skipped: 1 })
  for (let index = 0; index < 51; index++) writeFileSync(join(folder, `small-${index}.txt`), 'small')
  await expect(readAttachments(Array.from({ length: 51 }, (_, index) => join(folder, `small-${index}.txt`)), 'file')).rejects.toThrow('50 个')
  const largeFiles = Array.from({ length: 5 }, (_, index) => join(folder, `part-${index}.txt`))
  for (const path of largeFiles) writeFileSync(path, 'a'.repeat(120 * 1024))
  await expect(readAttachments(largeFiles, 'file')).rejects.toThrow('512 KiB')
})

it('reads folders beyond the former file count, per-file size and total byte limits without truncation', async () => {
  const folder = fixture()
  const large = 'a'.repeat(attachmentByteLimit + 1) + 'end-of-large-file'
  writeFileSync(join(folder, 'large.txt'), large)
  for (let index = 0; index < 60; index++) writeFileSync(join(folder, `small-${index}.txt`), `file-${index}`)
  const result = await readAttachments([folder], 'folder')
  expect(result.skipped).toBe(0)
  expect(result.attachments[0].fileCount).toBe(61)
  expect(result.attachments[0].content).toContain(large)
  expect(result.attachments[0].content).toContain('file-59')
  expect(validateAttachments(result.attachments)).toEqual(result.attachments)
  const { store, path } = await create()
  const first = store.begin('读取目录', false, 'test', result.attachments)
  expect(contextMessages(first.conversation).at(-1)?.content).toContain(large)
  expect(new StateService(new StateRepository(path)).state.conversations[0].messages[0].attachments?.[0]).toEqual(result.attachments[0])
  store.begin('', true, 'test')
  expect(contextMessages(first.conversation).at(-1)?.content).toContain('file-59')
})

it('keeps empty folders and excludes folders from independent-file attachment quotas', async () => {
  const result = await readAttachments([fixture()], 'folder')
  expect(result.attachments).toHaveLength(1)
  expect(result.attachments[0]).toMatchObject({ kind: 'folder', fileCount: 0, content: '' })
  const folders = Array.from({ length: 11 }, (_, index) => ({ ...result.attachments[0], id: String(index) }))
  expect(validateAttachments(folders)).toEqual(folders)
  expect(() => validateAttachments([{ ...folders[0], fileCount: -1 }])).toThrow('无效')
  expect(() => validateAttachments([{ ...folders[0], fileCount: 1 }])).toThrow('无效')
  expect(() => validateAttachments([{ ...folders[0], kind: 'file' }])).toThrow('无效')
})

it('rejects a forged IPC attachment or combined drafts that exceed the limit', () => {
  const attachment: Attachment = { id: 'a', name: 'code.ts', kind: 'file', fileCount: 1, content: 'code' }
  expect(() => validateAttachments([{ ...attachment, content: 12 }])).toThrow('无效')
  expect(() => validateAttachments([attachment, attachment])).toThrow('重复')
  expect(() => validateAttachments([{ ...attachment, content: '中'.repeat(attachmentByteLimit) }])).toThrow('512 KiB')
})

it('reports inaccessible selections without returning a partial attachment batch', async () => {
  const folder = fixture()
  const selected = join(folder, 'valid.ts')
  writeFileSync(selected, 'export const valid = true')
  await expect(readAttachments([selected, join(folder, 'missing.ts')], 'file')).rejects.toThrow('无法读取“missing.ts”')
})

it('persists attachment snapshots, supports attachment-only messages and reuses them for retry', async () => {
  const { store, path } = await create()
  const attachment: Attachment = { id: 'a', name: 'code.ts', kind: 'file', fileCount: 1, content: 'export const answer = 42' }
  const first = store.begin('', false, 'test', [attachment])
  expect(first.conversation.title).toBe('code.ts')
  expect(contextMessages(first.conversation).at(-1)?.content).toContain(attachment.content)
  attachment.content = 'modified elsewhere'
  expect(first.conversation.messages[0].attachments?.[0].content).toBe('export const answer = 42')
  store.begin('', true, 'test')
  expect(contextMessages(first.conversation).at(-1)?.content).toContain('export const answer = 42')
  expect(new StateService(new StateRepository(path)).state.conversations[0].messages[0].attachments?.[0].name).toBe('code.ts')
  expect(readFileSync(path, 'utf8')).not.toContain('modified elsewhere')
})

it('estimates matching request content, including Chinese drafts and attachments but excluding failed history', async () => {
  const { store } = await create()
  const attachment: Attachment = { id: 'a', name: 'code.ts', kind: 'file', fileCount: 1, content: 'a'.repeat(300) }
  const first = store.begin('failed question', false, 'test')
  first.message.content = 'failed answer'; first.message.status = 'error'
  const draft = '中文问题'
  const estimate = estimateContext(first.conversation, draft, [attachment])
  store.begin(draft, false, 'test', [attachment])
  const request = contextMessages(first.conversation)
  expect(request.map(item => item.content).join('\n')).not.toContain('failed')
  expect(estimate).toBe(request.reduce((sum, message) => sum + Math.ceil(Buffer.byteLength(message.content) / 3) + 4, 3))
  expect(estimate).toBeGreaterThan(estimateContext(undefined, draft, []))
})
