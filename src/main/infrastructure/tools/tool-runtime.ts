import { rmSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { ToolExecutionError, type AgentTool, type ToolDefinition, type ToolOutput, type ToolWorkspace } from '../../domain/llm'

/** 本次执行固定的目录与应用退出时清理的临时资源，不包含具体工具逻辑。 */
export interface ToolExecutionContext { readonly cwd: string; readonly temporaryDirectories: Set<string> }

/** 独立本机工具声明；运行层提供上下文后转换为 Agent 已有的工具契约。 */
export interface WorkspaceTool extends ToolDefinition {
  execute(args: Record<string, unknown>, signal: AbortSignal, context: ToolExecutionContext): Promise<string | ToolOutput>
}

/** 通用本机工具运行上下文；依赖 Node 清理资源，不导入任何具体工具。 */
export class ToolRuntime implements ToolWorkspace {
  private directory?: string
  private readonly temporaryDirectories = new Set<string>()

  /** 会话层每次发送前替换目录，undefined 清除此前的会话目录。 */
  setDirectory(directory?: string): void { this.directory = directory }

  /** 绑定任意本机工具，执行时捕获 cwd，并统一检查取消和转换系统错误。 */
  bind(tool: WorkspaceTool): AgentTool {
    return { name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters), execute: async (args, signal) => {
      signal.throwIfAborted()
      const cwd = this.directory
      if (!cwd || !isAbsolute(cwd)) throw new ToolExecutionError('请先选择工作文件夹。旧附件没有目录路径时需要重新选择。')
      try { return await tool.execute(args, signal, { cwd, temporaryDirectories: this.temporaryDirectories }) }
      catch (error) {
        signal.throwIfAborted()
        const code = (error as NodeJS.ErrnoException)?.code
        if (['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'ENOSPC', 'EROFS'].includes(code || '')) throw new ToolExecutionError(`文件操作失败（${code}），请检查路径、权限或磁盘空间。`)
        throw error
      }
    } }
  }

  /** 应用退出时仅清理已登记的工具临时目录，不触及用户工作目录。 */
  dispose(): void {
    for (const directory of this.temporaryDirectories) rmSync(directory, { recursive: true, force: true })
    this.temporaryDirectories.clear()
  }
}
