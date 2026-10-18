import { useMemo, useState } from 'react'
import { Button, Empty, Segmented, Tooltip } from 'antd'
import type { User } from '../../../../shared/types'
import { localDay, summarizeUsage, usageCalendar, type UsageRecord } from '../../../../shared/usage'
import './usage.css'

function tokenLabel(value: number): string {
  return value >= 100_000_000 ? `${Number((value / 100_000_000).toFixed(1))}亿` : value >= 10_000 ? `${Number((value / 10_000).toFixed(1))}万` : value.toLocaleString('zh-CN')
}
function durationLabel(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes} 分` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

/** 只显示当前账号的持久化实测数据，不以正文长度估算历史消耗。 */
export function UsageSettings({ user, records }: { user: User; records: UsageRecord[] }) {
  const [mode, setMode] = useState('daily')
  const today = localDay(new Date())
  const stats = useMemo(() => summarizeUsage(records, today), [records, today])
  const weeks = usageCalendar(stats.days, today)
  const cells = mode === 'weekly' ? weeks.map(week => ({ key: week.start, value: week.tokens, label: `${week.start} 至 ${week.end} · ${week.tokens.toLocaleString('zh-CN')} Token`, future: false }))
    : weeks.flatMap(week => week.dates.map(day => ({ key: day.date, value: mode === 'cumulative' ? day.cumulative : day.tokens, future: day.future,
      label: `${day.date} · ${day.tokens.toLocaleString('zh-CN')} Token${mode === 'cumulative' ? ` · 累计 ${day.cumulative.toLocaleString('zh-CN')} Token` : ''}` })))
  const max = Math.max(1, ...cells.map(cell => cell.future ? 0 : cell.value))
  const level = (value: number): number => value <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(value / max * 4)))
  return <div className="usage-settings">
    <div className="usage-profile"><div className="usage-avatar" aria-hidden="true">{user.name.slice(0, 2).toUpperCase()}</div><h3>{user.name}</h3><span>@{user.username}</span></div>
    <dl className="usage-overview">{[
      ['累计 Token 数', tokenLabel(stats.totalTokens)], ['单日 Token 峰值', tokenLabel(stats.peakTokens)], ['最长任务用时', durationLabel(stats.longestTaskMs)], ['最长连续天数', `${stats.longestStreak} 天`], ['当前连续天数', `${stats.currentStreak} 天`]
    ].map(([label, value]) => <div key={label}><dd>{value}</dd><dt>{label}</dt></div>)}</dl>
    <section className="usage-activity" aria-label="Token 活动">
      <header><h3>Token 活动</h3><Segmented aria-label="Token 活动视图" size="small" value={mode} onChange={value => setMode(String(value))} options={[{ label: '每天', value: 'daily' }, { label: '每周', value: 'weekly' }, { label: '累计总量', value: 'cumulative' }]} /></header>
      <div className="usage-calendar-scroll"><div className={`usage-calendar ${mode === 'weekly' ? 'usage-calendar-weekly' : ''}`}>
        <div className="usage-cells" role="group" aria-label={mode === 'weekly' ? '每周 Token 活动' : '每日 Token 活动'}>{cells.map(cell => cell.future ? <span key={cell.key} className="usage-cell-future" /> : <Tooltip key={cell.key} title={cell.label} trigger={['hover', 'focus']}><Button type="text" className="usage-cell" data-level={level(cell.value)} data-date={cell.key} aria-label={cell.label} /></Tooltip>)}</div>
        <div className="usage-months">{weeks.map((week, index) => <span key={week.start}>{index === 0 || week.start.slice(0, 7) !== weeks[index - 1].start.slice(0, 7) ? `${Number(week.start.slice(5, 7))}月` : ''}</span>)}</div>
      </div></div>
      <footer><span>{weeks[0].start} — {today}</span><span className="usage-legend">少{[0, 1, 2, 3, 4].map(value => <i key={value} data-level={value} />)}多</span></footer>
      <p className="usage-note">仅统计更新后服务返回的用量{stats.missingRequests ? ` · ${stats.missingRequests} 次请求未返回 Token 数` : ''}</p>
    </section>
    <div className="usage-rankings">{(['mcp', 'skill'] as const).map(kind => {
      const ranking = stats.tools.filter(tool => tool.kind === kind).slice(0, 5)
      return <section key={kind} className="usage-ranking" aria-label={kind === 'mcp' ? '常用 MCP' : '常用 Skill'}><header><h3>{kind === 'mcp' ? '常用 MCP' : '常用 Skill'}</h3><span>调用次数</span></header>
        {ranking.length ? <ol>{ranking.map(tool => <li key={tool.name}><div><span title={tool.name}>{tool.name}</span><strong>{tool.count.toLocaleString('zh-CN')}</strong></div><div className="usage-rank-track"><i style={{ width: `${tool.count / ranking[0].count * 100}%` }} /></div></li>)}</ol> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无调用记录" />}
      </section>
    })}</div>
  </div>
}
