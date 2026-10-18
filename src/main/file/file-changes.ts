import { randomUUID } from 'node:crypto'
import type { Snapshot, StreamEvent, UndoFilesInput } from '../../shared/types'
import type { FileChangeTurn } from '../domain/llm'
import { ToolExecutionError } from '../domain/llm'
import type { StoredFileChange } from '../domain/state'
import { describeChange, displayFilePath, fileBytes, fileVersion, restoreFile, withFileChanges } from '../infrastructure/file-history'
import { StateService } from '../services/state-service'

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

  /**  */
  async record(turn: FileChangeTurn, path: string, beforeText: string | null, afterText: string, write: () => Promise<void>): Promise<void> {
    //确认这次修改确实属于一个有效的会话和回复
    const conversation = this.store.conversation(turn.conversationId)
    if (!conversation.messages.
    some(message => message.id === turn.messageId && message.role === 'assistant'))
      throw new ToolExecutionError('无法定位本轮文件修改。')
    //{
    //   content: '当前文件内容的 Base64 编码',
    //   parentDirectory: '真实父目录路径',
    //   mode: 文件权限
    // }
    const version = await fileVersion(path)
    const before = fileBytes(beforeText)
    if (version.content !== before) throw new ToolExecutionError('文件内容已变化，请重新读取后再修改。')
    //查找“同一条 AI 回复 + 同一个文件绝对路径”是否已经有修改记录
    const previous =
        this.store.state.fileChanges?.
        find(change => change.messageId === turn.messageId && change.absolutePath === path)
    //如果之前的修改还没有撤销，那么本次修改的起点，必须等于上次记录的终点。
    if (previous && previous.status !== 'reverted' && previous.after !== before)
      throw new ToolExecutionError('文件已被其他操作修改，请先处理已有变更。')
    //确定新起点，上轮对话有修改且未撤销则起点为上次的起点,否则为此次
    const original = previous && previous.status !== 'reverted' ? previous.before : before
    const after = fileBytes(afterText)
    const name = displayFilePath(path, conversation.directory)
    const id = previous?.id || randomUUID()
    this.store.transaction(() => {
      //如果还没有 fileChanges 数组，就创建空数组并保存到状态里。changes 引用的就是这个数组。
      const changes = this.store.state.fileChanges ||= []
      const entry: StoredFileChange = {
        id,
        userId: conversation.userId,
        conversationId: conversation.id,
        messageId: turn.messageId,
        absolutePath: path,
        parentDirectory: version.parentDirectory,
        path: name,
        before: original,
        after,
        status: 'pending',
        //   返回:
        //   * additions: 增加的行数,
        //   * deletions: 删除的行数,
        //   * preview: 内容和差异预览
        ...describeChange(name, original, after) }
      const index = changes.findIndex(change => change.id === id)
      //findIndex没找到会返回-1
      if (index < 0) changes.push(entry)
      else changes[index] = entry
    })
    //新建时文件是否被其他操作创建而失败
    let exclusiveConflict = false
    //写入是否异常
    let writeFailed = false
    try {
      await write()
    }
    catch (error) {
      writeFailed = true
      // 1.删除本次准备的记录。
      // 2.如果之前有旧记录，恢复旧记录。
      // 3.将错误继续抛给调用方。
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
        exclusiveConflict = true
        this.store.transaction(() => {
          this.store.state.fileChanges = this.store.state.fileChanges!
              .filter(change => change.id !== id)
          if (previous) this.store.state.fileChanges.push(previous)
        })
      }
      throw error
    }
    finally {
      //已恢复不参与
      if (!exclusiveConflict) {
        const actual = await fileVersion(path, version.parentDirectory)
        this.store.transaction(() => {
          const entry = this.store.state.fileChanges!.find(change => change.id === id)!
          // 想将a写成b，但只写入了一部分成为了状态p就报错，也需要记录本次before为a，after为p，方便后续恢复
          if (writeFailed) entry.after = actual.content
          entry.status = 'applied'
          //重新计算预览并更新
          if (writeFailed && actual.content !== after)
            Object.assign(entry, describeChange(name, original, actual.content))
        })
      }
      this.publish(turn)
    }
  }

  /** 只使用当前账号已保存的变更 ID；先核对整批，再按文件恢复并保存进度，失败可以重试。
   *输入:  conversationId: string
   *      messageId: string
   *      changeId?: string,如果不传 changeId表示撤销这条回复对应的全部剩余修改。
   * */
  async undo(input: UndoFilesInput): Promise<Snapshot> {
    if (!input || typeof input.conversationId !== 'string' ||
        typeof input.messageId !== 'string' ||
        (input.changeId !== undefined && typeof input.changeId !== 'string'))
      throw new Error('撤销请求无效。')
    const conversation = this.store.conversation(input.conversationId)
    if (!conversation.messages.
    some(message => message.id === input.messageId && message.role === 'assistant'))
      throw new Error('回复不存在。')
    const changes =
        (this.store.state.fileChanges || []).
        filter(change =>
            change.userId === conversation.userId &&
            change.conversationId === conversation.id &&
            change.messageId === input.messageId &&
            (input.changeId === undefined || change.id === input.changeId))
    if (!changes.length) throw new Error('没有可撤销的文件修改。')
    //找到需要处理的撤销记录
    const pending = changes.filter(change =>
        change.status !== 'reverted' && change.before !== change.after)
    //withFileChanges作用:在这批文件恢复期间，其他使用同一套队列的应用内写入不能交错进入,防止锁死
    return withFileChanges(pending.map(change => change.absolutePath), async () => {
      //先检查文件是否已被修改
      for (const change of pending) {
        const current = await fileVersion(change.absolutePath, change.parentDirectory)
        if (current.content !== change.after && current.content !== change.before)
          throw new Error(`文件已被后续修改，无法撤销：${change.path}`)
      }
      try {
        for (const change of pending) {
          await restoreFile(change.absolutePath, change.parentDirectory, change.before, change.after)
          // 磁盘已恢复时保留内存进度；保存失败后可再次核对并重试，不回滚文件事实。
          this.store.state.fileChanges!.find(entry => entry.id === change.id)!.status = 'reverted'
          this.store.save()
        }
      }
      finally
      {
        this.publish(input)
      }
      this.store.save()
      return this.store.snapshot()
    })
  }

  /** 每次以当前仓库对象构造消息，避免其他事务回滚后使用旧引用。 */
  private publish(turn: FileChangeTurn): void {
    const message = this.store.state.conversations.find(
        conversation => conversation.id === turn.conversationId)
        ?.messages.find(message => message.id === turn.messageId)
    if (message)
      this.emit({ conversationId: turn.conversationId,
        //publicMessage() 会把属于这条回复的文件记录，整理后附加到消息上。
        message: this.store.publicMessage(message, turn.conversationId) })
  }
}
