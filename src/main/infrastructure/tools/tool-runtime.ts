import { rmSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { ToolExecutionError, type AgentTool, type AgentToolResult, type FileChangeTurn, type RecordFileChange, type ToolDefinition, type ToolExecutionMode, type ToolWorkspace } from '../../domain/llm'

/** 本次执行固定的目录、会话内已读文件的 mtimeMs 与退出时清理的临时资源。 */
export interface ToolExecutionContext {
  readonly cwd: string
  readonly readFileState: Map<string, number>
  readonly temporaryDirectories: Set<string>
  change?: (path: string, before: string | null, after: string, write: () => Promise<void>) => Promise<void>
}

/** 独立本机工具声明；运行层提供上下文后转换为 Agent 已有的工具契约。 */
export interface WorkspaceTool<TDetails = unknown> extends ToolDefinition {
  executionMode?: ToolExecutionMode
  execute(args: Record<string, unknown>, signal: AbortSignal, context: ToolExecutionContext): Promise<AgentToolResult<TDetails>>
}

/** 通用本机工具运行上下文；依赖 Node 清理资源，不导入任何具体工具。 */
export class ToolRuntime implements ToolWorkspace {
  private directory?: string
  private readFileState = new Map<string, number>()
  private readonly temporaryDirectories = new Set<string>()
  private turn?: FileChangeTurn
  private readonly changes = new Set<Promise<void>>()

  /** 应用注入持久化回调；独立使用工具时仍可不启用变更记录。 */
  constructor(private readonly recordChange?: RecordFileChange) {}

  /** 模型取消后，实际文件写入和恢复副本保存仍可能尚未结束。 */
  get changing(): boolean { return this.changes.size > 0 }

  /** 固定本次用户提问对应的回复 ID，取消后的磁盘收尾仍归属原轮次。 */
  setTurn(turn: FileChangeTurn): void { this.turn = { ...turn } }

  /** 停止和退出等待已经开始的文件写入结算，不等待不配合取消的其他工具。 */
  async waitForChanges(): Promise<void> { await Promise.allSettled([...this.changes]) }

  /** 会话层每次发送前替换目录，undefined 清除此前的会话目录。 */
  setDirectory(directory?: string): void {
    if (directory !== this.directory) this.readFileState = new Map()
    this.directory = directory
  }

  /** 绑定任意本机工具，执行时捕获 cwd，并统一检查取消和转换系统错误。 */
  bind(tool: WorkspaceTool): AgentTool {
    return { name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters), executionMode: tool.executionMode, execute: async (args, signal) => {
      signal.throwIfAborted()
      const cwd = this.directory
      if (!cwd || !isAbsolute(cwd)) throw new ToolExecutionError('请先选择工作文件夹。')
      const turn = this.turn
      const change: ToolExecutionContext['change'] = this.recordChange && turn ? async (path, before, after, write) => {
        const pending = this.recordChange!(turn, path, before, after, write)
        this.changes.add(pending)
        try { await pending } finally { this.changes.delete(pending) }
      } : undefined
      try { return await tool.execute(args, signal, { cwd, readFileState: this.readFileState, temporaryDirectories: this.temporaryDirectories, change }) }
      catch (error) {
        signal.throwIfAborted()
        const code = (error as NodeJS.ErrnoException)?.code
        if (['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'ENOSPC', 'EROFS'].includes(code || '')) throw new ToolExecutionError(`文件操作失败（${code}），请检查路径、权限或磁盘空间。`)
        throw error
      }
    } }
  }

  /** 逐个清理登记的目录；汇总失败并保留登记供重试，不触及用户工作目录。 */
  dispose(): void {
    this.readFileState = new Map()
    const errors: string[] = []
    for (const directory of this.temporaryDirectories) {
      try {
        rmSync(directory, { recursive: true, force: true })
        this.temporaryDirectories.delete(directory)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code
        errors.push(`${directory}：${code ? `${code}，` : ''}${error instanceof Error ? error.message : '目录删除失败。'}`)
      }
    }
    if (errors.length) throw new Error(`临时目录清理失败：\n${errors.join('\n')}`)
  }
}
