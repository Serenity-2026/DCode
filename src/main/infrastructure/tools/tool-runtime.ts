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

  /**
   * 外部传入如何记录文件change,现在是(turn, path, before, after, write) => changes.record(turn, path, before, after, write)
   * */
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

  /** 把一个需要“工作目录等额外信息”的文件工具，包装成 Agent 可以直接调用的工具。
   * Agent在执行工具时,会执行被包装后的execute()，structuredClone为深拷贝
   * */
  bind(tool: WorkspaceTool): AgentTool {
    return { name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters), executionMode: tool.executionMode, execute: async (args, signal) => {
      signal.throwIfAborted()
      const cwd = this.directory
      if (!cwd || !isAbsolute(cwd)) throw new ToolExecutionError('请先选择工作文件夹。')
      const turn = this.turn
      const change: ToolExecutionContext['change'] =
          //有记录文件修改的能力、知道本次修改属于哪一轮才开启文件记录功能，为工具执行上下文的change属性赋值
          this.recordChange && turn ?
              /*
                turn	conversationId: string; messageId: string
                path	修改的文件路径
                before	修改前内容
                after	计划写入的内容
                write	真正写文件的函数
                */
                async (path, before, after, write) => {
                //这个集合存的是“还没完成的文件修改任务”，不是文件版本内容。 真正的版本内容由 FileChanges 保存。!是非空断言,ts不回去检查其是否为null
                const pending = this.recordChange!(turn, path, before, after, write)
                this.changes.add(pending)
                try {
                  await pending
                }
                finally {
                  this.changes.delete(pending)
                }} : undefined;
                //上面就是在准备上下文,准备好后再执行工具
                try {
                  /*cwd	解析相对文件路径
                    readFileState	检查文件是否读过、修改时间是否变化
                    temporaryDirectories	登记以后需要清理的临时目录
                    change	写文件前保存恢复记录，再执行写入
                    因此不是每次执行工具都必然记录修改：读取工具不需要写文件，也就不需要调用 change()，只是我们会把recordChange这个函数
                    提供给所有工具使用
                  * */
                  return await tool.execute(args, signal,
            { cwd, readFileState: this.readFileState, temporaryDirectories: this.temporaryDirectories, change }
        ) }
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
