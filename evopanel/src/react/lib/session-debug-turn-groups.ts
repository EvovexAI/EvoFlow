import type { RequestRecord } from '../obs/types/index.js'

export type TurnGroup = {
  runId: string
  title: string
  /** Tooltip: chat seq / run id for对照调试 */
  titleHint: string
  chatSeq: number | null
  /** Absolute clock for the turn head (HH:mm:ss or short datetime) */
  timeLabel: string
  /** Full datetime + relative, for title tooltip */
  timeHint: string
  relativeLabel: string
  calls: RequestRecord[]
}

type TranscriptMsg = {
  seq?: unknown
  role?: unknown
  run_id?: unknown
  runId?: unknown
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Compact wall-clock for the narrow debug rail. */
export function fmtSessionDebugClock(
  iso?: string | null,
  fallback?: string | null,
): string {
  const raw = String(iso || '').trim()
  if (raw) {
    const d = new Date(raw)
    if (!Number.isNaN(d.getTime())) {
      const now = new Date()
      const sameDay =
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate()
      const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
      if (sameDay) return clock
      return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock}`
    }
  }
  const fb = String(fallback || '').trim()
  return fb && fb !== '—' ? fb : '—'
}

export function fmtSessionDebugFullTime(
  iso?: string | null,
  formattedFallback?: string | null,
): string {
  const raw = String(iso || '').trim()
  if (raw) {
    const d = new Date(raw)
    if (!Number.isNaN(d.getTime())) {
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
    }
  }
  const fb = String(formattedFallback || '').trim()
  return fb && fb !== '—' ? fb : '—'
}

function callSortKey(row: RequestRecord): string {
  return String(row.occurredAt || row.time || '')
}

/**
 * Map each run_id → chat DB seq for the user turn that started it.
 * Prefers the first user-row seq; falls back to the minimum seq in that run.
 */
export function buildRunIdToChatSeq(messages: unknown[]): Map<string, number> {
  const userSeq = new Map<string, number>()
  const anySeq = new Map<string, number>()
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue
    const m = raw as TranscriptMsg
    const runId = String(m.run_id ?? m.runId ?? '').trim()
    if (!runId) continue
    const seq = Number(m.seq)
    if (!Number.isFinite(seq) || seq <= 0) continue
    const n = Math.floor(seq)
    const role = String(m.role || '').trim().toLowerCase()
    if (role === 'user' || role === 'human') {
      const prev = userSeq.get(runId)
      if (prev == null || n < prev) userSeq.set(runId, n)
    }
    const prevAny = anySeq.get(runId)
    if (prevAny == null || n < prevAny) anySeq.set(runId, n)
  }
  const out = new Map<string, number>()
  for (const [runId, seq] of anySeq) {
    out.set(runId, userSeq.get(runId) ?? seq)
  }
  return out
}

export function groupCallsByTurn(
  calls: RequestRecord[],
  runIdToChatSeq?: Map<string, number> | null,
): TurnGroup[] {
  const ordered = [...calls].sort((a, b) => callSortKey(a).localeCompare(callSortKey(b)))
  const map = new Map<string, RequestRecord[]>()
  for (const call of ordered) {
    const runId = String(call.runId || '').trim() || '__unknown__'
    const bucket = map.get(runId)
    if (bucket) bucket.push(call)
    else map.set(runId, [call])
  }
  const groups: TurnGroup[] = []
  let turnIndex = 0
  for (const [runId, bucket] of map.entries()) {
    turnIndex += 1
    const first = bucket[0]
    const chatSeq =
      runId !== '__unknown__' && runIdToChatSeq?.has(runId)
        ? (runIdToChatSeq.get(runId) as number)
        : null
    const title = chatSeq != null ? `轮次 #${chatSeq}` : `轮次 ${turnIndex}`
    const titleHint =
      chatSeq != null
        ? `chat seq=${chatSeq} · run=${runId}`
        : runId !== '__unknown__'
          ? `run=${runId}`
          : ''
    const absolute = fmtSessionDebugClock(first?.occurredAt, first?.time)
    const full = fmtSessionDebugFullTime(first?.occurredAt, first?.time)
    const relative = String(first?.relativeTime || '').trim() || '—'
    // 组内调用记录：新在上、旧在下（符合查看习惯）
    const callsDesc = [...bucket].sort((a, b) =>
      callSortKey(b).localeCompare(callSortKey(a)),
    )
    groups.push({
      runId,
      title,
      titleHint,
      chatSeq,
      timeLabel: absolute,
      relativeLabel: relative,
      timeHint: relative !== '—' ? `${full} · ${relative}` : full,
      calls: callsDesc,
    })
  }
  return groups.reverse()
}
