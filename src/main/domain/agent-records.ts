import type { AgentRound } from '../../shared/types'
import { agentLimits } from './agent'

/** 校验可选执行记录的磁盘结构与边界；只检查数据，不执行或修复工具。 */
export function validAgentRounds(value: unknown): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value) || value.length > agentLimits.maxRounds) return false
  const ids = new Set<string>()
  for (const round of value as AgentRound[]) {
    if (!round || typeof round.content !== 'string' || typeof round.reasoning !== 'string' || !Array.isArray(round.toolCalls) || round.toolCalls.length > agentLimits.maxCallsPerRound) return false
    for (const execution of round.toolCalls) {
      const call = execution?.call
      if (!call || typeof call.id !== 'string' || !call.id || call.id.length > 256 || ids.has(call.id) || typeof call.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(call.name) || typeof call.arguments !== 'string' || new TextEncoder().encode(call.arguments).length > agentLimits.maxArgumentBytes) return false
      ids.add(call.id)
      if (!['pending', 'running', 'complete', 'error', 'stopped'].includes(execution.status)) return false
      if (execution.status === 'complete' || execution.status === 'error') {
        if (!execution.result || typeof execution.result.ok !== 'boolean' || typeof execution.result.content !== 'string' || execution.result.ok !== (execution.status === 'complete') || new TextEncoder().encode(execution.result.content).length > agentLimits.maxResultBytes) return false
      } else if (execution.result !== undefined) return false
    }
  }
  return true
}
