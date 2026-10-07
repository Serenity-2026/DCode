import type { AgentRound } from '../../shared/types'
import { abortable, agentLimits, type ModelDelta, type ModelGateway, type ModelMessage } from '../domain/agent'
import type { ModelConfig } from '../domain/model-config'
import { ToolRegistry } from './tool-registry'

/** 模型与工具的顺序调度服务；通过回调交付记录，持久化和任务身份由 Chat 负责。 */
export class AgentLoop {
  /** 注入模型端口与可信工具表；预算只能由主进程装配，不能由 IPC 输入修改。 */
  constructor(private readonly model: ModelGateway, private readonly tools: ToolRegistry, private readonly budget = { maxRounds: agentLimits.maxRounds as number, maxToolCalls: agentLimits.maxToolCalls as number, runTimeoutMs: agentLimits.runTimeoutMs as number }) {
    if (Object.values(budget).some(value => !Number.isSafeInteger(value) || value <= 0)) throw new Error('Agent 循环预算无效。')
    if (budget.maxRounds > agentLimits.maxRounds || budget.maxToolCalls > agentLimits.maxToolCalls) throw new Error('Agent 循环预算超过框架上限。')
  }

  /** 循环直至最终正文、失败或取消；每个工具执行前必须完成调用方的持久化检查点。 */
  async run(config: ModelConfig, initial: ModelMessage[], signal: AbortSignal, observer: { onRound: (round: AgentRound) => void; onDelta: (delta: ModelDelta) => void; onUpdate: () => void }): Promise<void> {
    signal.throwIfAborted()
    const controller = new AbortController()
    const abort = (): void => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('Agent 运行超时。')), this.budget.runTimeoutMs)
    const messages = structuredClone(initial)
    const definitions = this.tools.definitions()
    const ids = new Set<string>()
    let toolCount = 0
    try {
      for (let index = 0; index < this.budget.maxRounds; index++) {
        controller.signal.throwIfAborted()
        const round: AgentRound = { content: '', reasoning: '', toolCalls: [] }
        observer.onRound(round)
        const turn = await abortable(() => this.model.stream(config, messages, controller.signal, delta => {
          if (controller.signal.aborted) return
          round.content += delta.content || ''
          round.reasoning += delta.reasoning || ''
          observer.onDelta(delta)
        }, definitions), controller.signal)
        controller.signal.throwIfAborted()
        if (turn.finishReason === 'stop') {
          if (turn.toolCalls.length) throw new Error('模型工具调用结束原因无效。')
          if (!turn.content.trim()) throw new Error('模型没有返回文本，请重试。')
          return
        }
        if (!turn.toolCalls.length || turn.toolCalls.length > agentLimits.maxCallsPerRound) throw new Error('模型工具调用数量无效。')
        for (const call of turn.toolCalls) {
          if (!call.id || ids.has(call.id)) throw new Error('模型工具调用 ID 无效或重复。')
          ids.add(call.id)
        }
        round.toolCalls = turn.toolCalls.map(call => ({ call, status: 'pending' }))
        observer.onUpdate()
        if (index === this.budget.maxRounds - 1 || toolCount + turn.toolCalls.length > this.budget.maxToolCalls) throw new Error('Agent 已达到循环或工具调用上限。')
        toolCount += turn.toolCalls.length
        messages.push({ role: 'assistant', content: turn.content, reasoning: turn.reasoning, toolCalls: turn.toolCalls })
        for (const execution of round.toolCalls) {
          controller.signal.throwIfAborted()
          execution.status = 'running'
          observer.onUpdate()
          try {
            execution.result = await this.tools.execute(execution.call, controller.signal)
            execution.status = execution.result.ok ? 'complete' : 'error'
          } catch (error) {
            execution.status = 'stopped'
            throw error
          }
          observer.onUpdate()
          messages.push({ role: 'tool', toolCallId: execution.call.id, content: JSON.stringify(execution.result) })
        }
      }
    } finally {
      controller.abort()
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }
}
