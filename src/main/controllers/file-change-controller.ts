import { channels } from '../../shared/channels'
import type { UndoFilesInput } from '../../shared/types'
import { IpcRouter } from '../ipc/ipc-router'
import { AgentSessions } from '../services/agent-sessions'
import { FileChanges } from '../services/file-changes'

/** 撤销只接受已保存的变更 ID；生成结束后短暂互斥，避免恢复过程中启动新任务。 */
export function registerFileChangeController(router: IpcRouter, changes: FileChanges, sessions: AgentSessions): void {
  router.handle<UndoFilesInput>(channels.undoFiles, input => router.exclusive(() => {
    if (sessions.busy) throw new Error('请先停止正在运行的任务，再撤销文件修改。')
    return changes.undo(input)
  }))
}
