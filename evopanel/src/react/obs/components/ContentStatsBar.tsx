import {
  fmtContentStats,
  type ContentStats,
} from '../lib/obs-text-stats'

export function ContentStatsBar({
  stats,
  label,
}: {
  stats: ContentStats | null | undefined
  label?: string
}) {
  if (!stats) return null
  const text = fmtContentStats(stats)
  if (!text) return null
  return (
    <div className="obs-content-stats-bar" title={label || '字符数与 token 估算'}>
      {label ? <span className="obs-content-stats-bar-label">{label}</span> : null}
      <span className="obs-content-stats-bar-value">{text}</span>
    </div>
  )
}
