import type { ToolCall, ToolResult } from '../../shared/types'
import { abortable, agentLimits, type AgentTool, type ToolDefinition } from '../domain/agent'
import { compileToolParameters } from '../infrastructure/tool-parameters'

/** 可信工具白名单与执行边界；依赖 schema 编译器，不读取文件、窗口或模型凭据。 */
export class ToolRegistry {
  private readonly tools = new Map<string, { tool: AgentTool; validate: (value: unknown) => boolean }>()

  /** 启动时复制定义并预编译 schema；重复名称、无效名称和 schema 直接拒绝。 */
  constructor(tools: AgentTool[], private readonly timeoutMs: number = agentLimits.toolTimeoutMs) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('工具超时配置无效。')
    for (const tool of tools) {
      const definition = structuredClone(tool.definition)
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(definition.name) || !definition.description.trim() || this.tools.has(definition.name)) throw new Error('工具名称无效或重复。')
      this.tools.set(definition.name, { tool: { definition, execute: tool.execute.bind(tool) }, validate: compileToolParameters(definition) })
    }
  }

  /** 返回定义副本供模型选择，调用方无法修改注册表内的 schema。 */
  definitions(): ToolDefinition[] { return structuredClone([...this.tools.values()].map(item => item.tool.definition)) }

  /** 校验 JSON/schema 后执行；可恢复失败回传模型，取消则立即向外抛出。 */
  async execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    signal.throwIfAborted()
    const registered = this.tools.get(call.name)
    if (!registered) return { ok: false, content: '工具未注册，不能执行此调用。' }
    if (new TextEncoder().encode(call.arguments).length > agentLimits.maxArgumentBytes) return { ok: false, content: '工具参数超过大小上限。' }
    let parameters: unknown
    try { parameters = JSON.parse(call.arguments) } catch { return { ok: false, content: '工具参数不是有效 JSON，请修正后重试。' } }
    if (!registered.validate(parameters)) return { ok: false, content: '工具参数不符合 JSON Schema，请按定义修正。' }
    const controller = new AbortController()
    const abort = (): void => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, this.timeoutMs)
    try {
      const content = await abortable(() => registered.tool.execute(parameters as Record<string, unknown>, { signal: controller.signal }), controller.signal)
      signal.throwIfAborted()
      if (typeof content !== 'string' || new TextEncoder().encode(content).length > agentLimits.maxResultBytes) return { ok: false, content: '工具结果格式无效或超过大小上限。' }
      return { ok: true, content }
    } catch {
      signal.throwIfAborted()
      return { ok: false, content: timedOut ? '工具执行超时。' : '工具执行失败。' }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }
}
