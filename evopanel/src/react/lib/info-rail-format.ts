/** Shared time + scope labels for Info Rail artifacts / platform rows. */

export type InfoRailScope = 'latest' | 'turn' | 'existing'

export function formatInfoRailTime(isoOrMs?: string | number | null): string {
  if (isoOrMs == null || isoOrMs === '') return ''
  let ms: number
  if (typeof isoOrMs === 'number') {
    ms = isoOrMs
  } else {
    const s = String(isoOrMs).trim()
    if (!s) return ''
    ms = /^\d+$/.test(s) ? Number(s) : Date.parse(s)
  }
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''

  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const yyyy = d.getFullYear()
  const mo = (d.getMonth() + 1).toString().padStart(2, '0')
  const dd = d.getDate().toString().padStart(2, '0')
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  const ss = d.getSeconds().toString().padStart(2, '0')

  if (sameDay) return `${hh}:${mm}:${ss}`
  if (yyyy === now.getFullYear()) return `${mo}-${dd} ${hh}:${mm}`
  return `${yyyy}-${mo}-${dd} ${hh}:${mm}`
}

export function infoRailScopeLabel(scope: InfoRailScope): string {
  if (scope === 'latest') return '最新'
  if (scope === 'turn') return '本轮'
  return '已有'
}

export function artifactTimestampMs(it: { updatedAt?: string; createdAt?: string }): number {
  for (const raw of [it.updatedAt, it.createdAt]) {
    const s = String(raw || '').trim()
    if (!s) continue
    const ms = Date.parse(s)
    if (Number.isFinite(ms) && ms > 0) return ms
  }
  return 0
}

/** Parse ``round:2026-08-26T12:32:36…`` or ISO into display time. */
export function formatDutyRoundClock(raw?: string | null): string {
  const s = String(raw || '').trim()
  if (!s) return ''
  let iso = s
  const m = s.match(/^round:(.+)$/i)
  if (m) iso = m[1]
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''

  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  if (sameDay) return `今天 ${hh}:${mm}`
  const mo = (d.getMonth() + 1).toString().padStart(2, '0')
  const dd = d.getDate().toString().padStart(2, '0')
  if (d.getFullYear() === now.getFullYear()) return `${mo}-${dd} ${hh}:${mm}`
  return `${d.getFullYear()}-${mo}-${dd} ${hh}:${mm}`
}

export function formatCompactCount(n: number): string {
  const v = Number(n)
  if (!Number.isFinite(v) || v < 0) return '0'
  if (v >= 10000) {
    const w = v / 10000
    return `${w >= 10 ? Math.round(w) : w.toFixed(1).replace(/\.0$/, '')}万`
  }
  if (v >= 1000) {
    const k = v / 1000
    return `${k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`
  }
  return String(Math.round(v))
}

export type ProactiveSessionKind = 'legacy' | 'duty' | 'task' | 'chat'

/** Infer task kicker from title + session kind (chat session may still show a patrol task). */
export function inferEmployeeTaskKind(
  title: string,
  sessionKind: ProactiveSessionKind,
): string {
  const t = String(title || '').trim()
  if (/巡检|值班/.test(t)) return '巡检'
  if (/派发|急活|派活/.test(t)) return '派发'
  if (sessionKind === 'duty') return '值班'
  if (sessionKind === 'task') return '任务'
  if (sessionKind === 'chat') return '对话'
  return '工作'
}

export function proactiveBusySessionHint(
  busySessionKey: string,
  currentSessionKey: string,
): string | null {
  const busy = String(busySessionKey || '').trim()
  const current = String(currentSessionKey || '').trim()
  if (!busy || busy === current) return null
  if (busy.includes(':duty:')) return '值班巡检进行中'
  if (busy.includes(':task:')) return '任务会话执行中'
  if (busy.includes(':chat:')) return '另一对话进行中'
  return '其他会话进行中'
}

export function shortenTaskId(taskId: string): string {
  const id = String(taskId || '').trim()
  if (!id) return ''
  if (id.length <= 14) return id
  return `…${id.slice(-10)}`
}
