import { createHash } from 'node:crypto'
import type { CallToolResult, Tool } from '@modelcontextprotocol/client'
import type { AgentTool, AgentToolResult, JsonValue, ToolContent, ToolImage } from '../../domain/llm'
import { ToolExecutionError } from '../../domain/llm'
import { toolValidator } from '../tool-schema'

/** 稳定名称同时满足模型供应商的 64 字符限制，哈希避免截断或规范化后重名。 */
export function mcpToolName(server: string, tool: string): string {
  const raw = `mcp__${server}__${tool}`
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 12)
  return `${raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50)}_${hash}`
}

/** 返回有界文本和图片，明确标记不支持的内容；不把 MCP 私有 _meta 发送给模型。 */
export function mcpResult(result: CallToolResult): AgentToolResult {
  const content: ToolContent[] = []
  let remaining = 24_000
  let truncated = false
  let imageBytes = 0
  const text = (value: string): void => {
    if (remaining <= 0) { truncated ||= Boolean(value); return }
    const clipped = value.length > remaining
    content.push({ type: 'text', text: value.slice(0, remaining) })
    truncated ||= clipped
    remaining -= value.length
  }
  for (const block of result.content) {
    if (block.type === 'text') text(block.text)
    else if (block.type === 'image' && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(block.mimeType) && imageBytes + block.data.length <= 8_000_000) {
      imageBytes += block.data.length
      content.push({ type: 'image', data: block.data, mimeType: block.mimeType as ToolImage['mimeType'] })
    } else if (block.type === 'resource' && 'text' in block.resource) text(block.resource.text)
    else if (block.type === 'resource_link') text(`资源：${block.name}\n${block.uri}${block.description ? `\n${block.description}` : ''}`)
    else text(`[暂不支持的 MCP 内容：${block.type}]`)
  }
  if (result.structuredContent && !result.content.length) text(JSON.stringify(result.structuredContent))
  if (truncated) content.push({ type: 'text', text: '[MCP 输出已截断]' })
  if (!content.length) text(result.isError ? 'MCP 工具执行失败。' : 'MCP 工具执行完成。')
  return { content, details: {}, isError: Boolean(result.isError), ...(result.structuredContent ? { structuredContent: result.structuredContent as JsonValue } : {}) }
}

export function mcpTool(server: string, tool: Tool, call: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<CallToolResult>): AgentTool {
  const definition: AgentTool = {
    name: mcpToolName(server, tool.name), description: (tool.description || `${server}/${tool.name}`).slice(0, 4096),
    parameters: { ...tool.inputSchema, type: 'object', properties: tool.inputSchema.properties || {} },
    usageIdentity: { kind: 'mcp', name: `${server}/${tool.name}` },
    // 服务自报的 readOnlyHint 不是授权，第一版保持串行执行。
    executionMode: 'sequential',
    async execute(args, signal) {
      try { return mcpResult(await call(tool.name, args, signal)) }
      catch { if (signal.aborted) throw signal.reason; throw new ToolExecutionError(`MCP 工具 ${server}/${tool.name} 调用失败，请检查服务器连接。`) }
    }
  }
  toolValidator(definition, true)
  return definition
}
