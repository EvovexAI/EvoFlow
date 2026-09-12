import type { DisplayRow } from '../chat-types.js'

const STORAGE_KEY = 'evopanel-goal-closure-reports-v1'
const LEGACY_STORAGE_KEY = 'evopanel-hosted-closure-reports-v1'
const MAX_PER_SESSION = 24

type ClosureEntry = { ts: number; outcome: string; body: string }

/** 去掉判定器 JSON / 内部模板行，避免污染目标汇报正文 */
export function sanitizeGoalClosureBody(text: string): string {
  let body = String(text || '').trim()
  if (!body) return ''
  body = body.replace(
    /\{\s*"verdict"\s*:\s*"(?:continue|complete|wait_user)"[\s\S]*?\}/gi,
    '',
  )
  body = body
    .split('\n')
    .filter((line) => {
      const s = line.trim()
      if (!s) return true
      if (/^\[(?:Turn|Assistant reply|Goal)\]/i.test(s)) return false
      if (s.startsWith('{') && s.includes('verdict')) return false
      return true
    })
    .join('\n')
  return body.replace(/\n{3,}/g, '\n\n').trim()
}

function readStore(): Record<string, ClosureEntry[]> {
  try {
    let raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) raw = localStorage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) return {}
    const o = JSON.parse(raw) as unknown
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, ClosureEntry[]>) : {}
  } catch {
    return {}
  }
}

function writeStore(data: Record<string, ClosureEntry[]>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch {
    /* ignore quota */
  }
}

/** Normalize backend/API timestamps (seconds or ms) for closure row ordering. */
export function resolveGoalClosureTimestamp(source?: {
  ended_at?: number
  endedAt?: number
  last_run_at?: number
  lastRunAt?: number
}): number {
  const toMs = (v: number) => {
    if (!Number.isFinite(v) || v <= 0) return 0
    return v > 1e11 ? Math.floor(v) : Math.floor(v * 1000)
  }
  const ended = toMs(Number(source?.ended_at ?? source?.endedAt ?? 0))
  if (ended > 0) return ended
  const lastRun = toMs(Number(source?.last_run_at ?? source?.lastRunAt ?? 0))
  if (lastRun > 0) return lastRun
  return Date.now()
}

export function saveGoalClosureReport(sessionKey: string, entry: ClosureEntry) {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  const all = readStore()
  const prev = Array.isArray(all[sk]) ? all[sk] : []
  const outcome = String(entry.outcome || '').trim() || '（未知）'
  const body = sanitizeGoalClosureBody(entry.body || '') || '（无正文）'
  const normalized = { ...entry, ts: entry.ts || Date.now(), outcome, body }
  const last = prev[prev.length - 1]
  const now = normalized.ts
  // 同一目标的逐步完善：仅当上一条汇报在短时间内且 outcome 相同、新正文更长时升级；
  // 超过窗口视为不同目标，追加而非覆盖，避免历史汇报被误覆盖丢失。
  const UPGRADE_WINDOW_MS = 120_000
  const canUpgradeLast =
    last &&
    String(last.outcome || '').trim() === outcome &&
    (now - (last.ts || 0)) < UPGRADE_WINDOW_MS &&
    (body.length > String(last.body || '').trim().length + 24)
  const next = canUpgradeLast
    ? [...prev.slice(0, -1), { ...normalized, ts: last.ts || normalized.ts }]
    : [...prev, normalized]
  while (next.length > MAX_PER_SESSION) next.shift()
  all[sk] = next
  writeStore(all)
}

export function formatGoalClosureRowText(outcome: string, body: string): string {
  const o = String(outcome || '').trim() || '（未知）'
  const b = sanitizeGoalClosureBody(body) || '（无正文）'
  return `[目标汇报]\n**结束**: ${o}\n\n${b}`
}

function fingerprintClosureBubble(text: string): string {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function rowTimestampMs(row: DisplayRow): number | null {
  if (row.role === '_stream') return null
  const ts = row.timestamp
  if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) return ts
  return null
}

/** Insert closure system rows by timestamp; keep `_stream` pinned at tail. */
export function resolveClosureInsertIndex(rows: DisplayRow[], closureTs: number): number {
  const ts = Number(closureTs) || 0
  const streamIdx = rows.findIndex((r) => r.role === '_stream')
  const limit = streamIdx >= 0 ? streamIdx : rows.length
  if (!limit) return 0

  let inheritedTs = 0
  for (let i = 0; i < limit; i++) {
    const direct = rowTimestampMs(rows[i]!)
    if (direct != null) inheritedTs = direct
    const effectiveTs = direct ?? inheritedTs
    if (effectiveTs > ts) return i
  }
  return limit
}

export function insertClosureRowsByTimestamp(rows: DisplayRow[], extras: DisplayRow[]): DisplayRow[] {
  if (!extras.length) return rows
  const sortedExtras = [...extras].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
  const out = [...rows]
  for (const extra of sortedExtras) {
    const idx = resolveClosureInsertIndex(out, extra.timestamp || 0)
    out.splice(idx, 0, extra)
  }
  return out
}

export function mergeRowsWithGoalClosureEphemerals(
  rows: DisplayRow[],
  sessionKey: string | null,
): DisplayRow[] {
  const sk = String(sessionKey || '').trim()
  if (!sk) return rows
  const stored = readStore()[sk]
  if (!Array.isArray(stored) || !stored.length) return rows

  const seen = new Set<string>()
  for (const r of rows) {
    if (r.role === 'system' && String(r.text || '').trimStart().startsWith('[目标汇报]')) {
      seen.add(fingerprintClosureBubble(String(r.text)))
    }
  }

  const extra: DisplayRow[] = []
  for (const e of stored) {
    const text = formatGoalClosureRowText(e.outcome, e.body)
    const fp = fingerprintClosureBubble(text)
    if (seen.has(fp)) continue
    seen.add(fp)
    extra.push({
      role: 'system',
      text,
      timestamp: e.ts,
    })
  }
  if (!extra.length) return rows

  return insertClosureRowsByTimestamp(rows, extra)
}

/** @deprecated */
export const saveHostedClosureReport = saveGoalClosureReport
/** @deprecated */
export const formatHostedClosureRowText = formatGoalClosureRowText
/** @deprecated */
export const mergeRowsWithHostedClosureEphemerals = mergeRowsWithGoalClosureEphemerals
