import { randomUUID } from 'node:crypto'
import type { Snapshot, StreamEvent, UndoFilesInput } from '../../shared/types'
import type { FileChangeTurn } from '../domain/llm'
import { ToolExecutionError } from '../domain/llm'
import type { StoredFileChange } from '../domain/state'
import { describeChange, displayFilePath, fileBytes, fileVersion, restoreFile, withFileChanges } from '../infrastructure/file-history'
import { StateService } from './state-service'

/** 按用户提问记录文件净变化及完整恢复副本；依赖状态仓库持久化，系统适配负责读写。 */
export class FileChanges {
  /** 注入公开消息推送，备份正文不会进入流事件或模型上下文。 */
  constructor(private readonly store: StateService, private readonly emit: (event: StreamEvent) => void) {}

  /** 重启后只确认与写前或预期写后完全一致的未完成记录，其他情况保留冲突检查。 */
  async recover(): Promise<void> {
    for (const change of this.store.state.fileChanges || []) if (change.status === 'pending') {
      try {
        const current = await fileVersion(change.absolutePath, change.parentDirectory)
        if (current.content === change.after) change.status = 'applied'
        else if (current.content === change.before) change.status = 'reverted'
      } catch { /* 无法核实的记录保留备份，撤销时报告实际原因。 */ }
    }
    this.store.save()
  }

  /** 在同路径队列内先持久化原文，再写磁盘；即使写入失败或取消，也捕获已发生的实际变化。 */
  async record(turn: FileChangeTurn, path: string, beforeText: string | null, afterText: string, write: () => Promise<void>): Promise<void> {
    const conversation = this.store.conversation(turn.conversationId)
    if (!conversation.messages.some(message => message.id === turn.messageId && message.role === 'assistant')) throw new ToolExecutionError('无法定位本轮文件修改。')
    const version = await fileVersion(path)
    const before = fileBytes(beforeText)
    if (version.content !== before) throw new ToolExecutionError('文件内容已变化，请重新读取后再修改。')
    const previous = this.store.state.fileChanges?.find(change => change.messageId === turn.messageId && change.absolutePath === path)
    if (previous && previous.status !== 'reverted' && previous.after !== before) throw new ToolExecutionError('文件已被其他操作修改，请先处理已有变更。')
    const original = previous && previous.status !== 'reverted' ? previous.before : before
    const after = fileBytes(afterText)
    const name = displayFilePath(path, conversation.directory)
    const id = previous?.id || randomUUID()
    this.store.transaction(() => {
      const changes = this.store.state.fileChanges ||= []
      const entry: StoredFileChange = { id, userId: conversation.userId, conversationId: conversation.id, messageId: turn.messageId, absolutePath: path, parentDirectory: version.parentDirectory,
        path: name, before: original, after, status: 'pending', ...describeChange(name, original, after) }
      const index = changes.findIndex(change => change.id === id)
      if (index < 0) changes.push(entry)
      else changes[index] = entry
    })
    let exclusiveConflict = false
    let writeFailed = false
    try { await write() }
    catch (error) {
      writeFailed = true
      // wx 被外部新文件抢占时没有写入任何字节，不能把外部文件归入本轮并允许删除。
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
        exclusiveConflict = true
        this.store.transaction(() => {
          this.store.state.fileChanges = this.store.state.fileChanges!.filter(change => change.id !== id)
          if (previous) this.store.state.fileChanges.push(previous)
        })
      }
      throw error
    }
    finally {
      if (!exclusiveConflict) {
        const actual = await fileVersion(path, version.parentDirectory)
        this.store.transaction(() => {
          const entry = this.store.state.fileChanges!.find(change => change.id === id)!
          // 成功写入后的外部编辑不属于本轮；保留预期写后副本，使撤销能够检测冲突。
          if (writeFailed) entry.after = actual.content
          entry.status = 'applied'
          if (writeFailed && actual.content !== after) Object.assign(entry, describeChange(name, original, actual.content))
        })
      }
      this.publish(turn)
    }
  }

  /** 只使用当前账号已保存的变更 ID；先核对整批，再按文件恢复并保存进度，失败可以重试。 */
  async undo(input: UndoFilesInput): Promise<Snapshot> {
    if (!input || typeof input.conversationId !== 'string' || typeof input.messageId !== 'string' || (input.changeId !== undefined && typeof input.changeId !== 'string')) throw new Error('撤销请求无效。')
    const conversation = this.store.conversation(input.conversationId)
    if (!conversation.messages.some(message => message.id === input.messageId && message.role === 'assistant')) throw new Error('回复不存在。')
    const changes = (this.store.state.fileChanges || []).filter(change => change.userId === conversation.userId && change.conversationId === conversation.id && change.messageId === input.messageId && (input.changeId === undefined || change.id === input.changeId))
    if (!changes.length) throw new Error('没有可撤销的文件修改。')
    const pending = changes.filter(change => change.status !== 'reverted' && change.before !== change.after)
    return withFileChanges(pending.map(change => change.absolutePath), async () => {
      for (const change of pending) {
        const current = await fileVersion(change.absolutePath, change.parentDirectory)
        if (current.content !== change.after && current.content !== change.before) throw new Error(`文件已被后续修改，无法撤销：${change.path}`)
      }
      try {
        for (const change of pending) {
          await restoreFile(change.absolutePath, change.parentDirectory, change.before, change.after)
          // 磁盘已恢复时保留内存进度；保存失败后可再次核对并重试，不回滚文件事实。
          this.store.state.fileChanges!.find(entry => entry.id === change.id)!.status = 'reverted'
          this.store.save()
        }
      } finally { this.publish(input) }
      this.store.save()
      return this.store.snapshot()
    })
  }

  /** 每次以当前仓库对象构造消息，避免其他事务回滚后使用旧引用。 */
  private publish(turn: FileChangeTurn): void {
    const message = this.store.state.conversations.find(conversation => conversation.id === turn.conversationId)?.messages.find(message => message.id === turn.messageId)
    if (message) this.emit({ conversationId: turn.conversationId, message: this.store.publicMessage(message, turn.conversationId) })
  }
}
