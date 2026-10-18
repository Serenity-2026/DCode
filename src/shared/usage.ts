/** 由注册工具声明统计归属；不从模型提供的工具名称推断 MCP 或 Skill。 */
export interface ToolUsageIdentity { kind: 'mcp' | 'skill'; name: string }
export interface ToolUsageCount extends ToolUsageIdentity { count: number }

/** 每次生成独立记账，删除聊天或重新生成不会删除已经消耗的用量。 */
export interface UsageRecord {
  id: string
  startedAt: string
  lastActiveAt: string
  finishedAt?: string
  requests: number
  reportedRequests: number
  days: Record<string, number>
  tools: ToolUsageCount[]
}

export function isTokenCount(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
export function shiftDay(day: string, offset: number): string {
  const date = new Date(`${day}T12:00:00`)
  date.setDate(date.getDate() + offset)
  return localDay(date)
}

/** 磁盘新增字段保持可选；存在时校验完整记录，避免损坏数据进入统计。 */
export function isUsageRecord(value: unknown): value is UsageRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as UsageRecord
  const timestamp = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v))
  return typeof r.id === 'string' && Boolean(r.id) && timestamp(r.startedAt) && timestamp(r.lastActiveAt)
    && Date.parse(r.lastActiveAt) >= Date.parse(r.startedAt)
    && (r.finishedAt === undefined || timestamp(r.finishedAt) && Date.parse(r.finishedAt) >= Date.parse(r.startedAt))
    && isTokenCount(r.requests) && isTokenCount(r.reportedRequests) && r.reportedRequests <= r.requests
    && Boolean(r.days) && typeof r.days === 'object' && !Array.isArray(r.days)
    && Object.entries(r.days).every(([day, tokens]) => /^\d{4}-\d{2}-\d{2}$/.test(day) && localDay(new Date(`${day}T12:00:00`)) === day && isTokenCount(tokens))
    && Array.isArray(r.tools) && r.tools.every(tool => tool && ['mcp', 'skill'].includes(tool.kind) && typeof tool.name === 'string' && Boolean(tool.name.trim()) && isTokenCount(tool.count))
}

export function summarizeUsage(records: UsageRecord[], today = localDay(new Date())) {
  const days = new Map<string, number>()
  const tools = new Map<string, ToolUsageCount>()
  let longestTaskMs = 0
  let missingRequests = 0
  for (const record of records) {
    for (const [day, tokens] of Object.entries(record.days)) days.set(day, (days.get(day) || 0) + tokens)
    for (const tool of record.tools) {
      const key = JSON.stringify([tool.kind, tool.name])
      const current = tools.get(key)
      tools.set(key, { ...tool, count: (current?.count || 0) + tool.count })
    }
    if (record.finishedAt) longestTaskMs = Math.max(longestTaskMs, Date.parse(record.finishedAt) - Date.parse(record.startedAt))
    missingRequests += record.requests - record.reportedRequests
  }
  const active = [...days].filter(([, tokens]) => tokens > 0).map(([day]) => day).sort()
  let longestStreak = 0
  let streak = 0
  for (let i = 0; i < active.length; i++) {
    streak = i && shiftDay(active[i - 1], 1) === active[i] ? streak + 1 : 1
    longestStreak = Math.max(longestStreak, streak)
  }
  let currentStreak = 0
  let day = days.get(today) ? today : shiftDay(today, -1)
  while ((days.get(day) || 0) > 0) { currentStreak++; day = shiftDay(day, -1) }
  return { days, totalTokens: [...days.values()].reduce((sum, count) => sum + count, 0), peakTokens: Math.max(0, ...days.values()), longestTaskMs, longestStreak, currentStreak, missingRequests,
    tools: [...tools.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)) }
}

/** 固定 53 周，按本地自然日生成；周视图合并日值，累计从账号第一条记录开始。 */
export function usageCalendar(days: Map<string, number>, today = localDay(new Date())) {
  const weekday = (new Date(`${today}T12:00:00`).getDay() + 6) % 7
  const start = shiftDay(today, -weekday - 52 * 7)
  let cumulative = [...days].filter(([day]) => day < start).reduce((sum, [, count]) => sum + count, 0)
  return Array.from({ length: 53 }, (_, week) => {
    const dates = Array.from({ length: 7 }, (_, offset) => {
      const date = shiftDay(start, week * 7 + offset)
      const tokens = days.get(date) || 0
      cumulative += tokens
      return { date, tokens, cumulative, future: date > today }
    })
    return { start: dates[0].date, end: dates[6].date > today ? today : dates[6].date, tokens: dates.reduce((sum, day) => sum + day.tokens, 0), dates }
  })
}
