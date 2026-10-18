import { channels } from '../../shared/channels'
import type { McpAction, McpServerDraft } from '../../shared/mcp'
import { IpcRouter } from '../ipc/ipc-router'
import { McpService } from '../services/mcp-service'

export function registerMcpController(router: IpcRouter, mcp: McpService, busy: () => boolean): void {
  const idle = (): void => { if (busy()) throw new Error('请先停止正在运行的任务，再修改 MCP 服务器。') }
  router.handle(channels.listMcpServers, () => mcp.list())
  router.handle<McpServerDraft>(channels.saveMcpServer, input => router.exclusive(async () => { idle(); return mcp.save(input) }))
  router.handle<McpAction>(channels.mcpAction, input => router.exclusive(async () => { idle(); return mcp.act(input) }))
}
