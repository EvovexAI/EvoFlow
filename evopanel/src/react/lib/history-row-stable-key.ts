import type { DisplayRow } from '../chat-types.js'

/** Short stable fingerprint — length alone collides on same-ms proactive prompts. */
function textFingerprint(text: string): string {
  const s = String(text || '')
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i)
  }
  return `${s.length.toString(36)}_${(h >>> 0).toString(36)}`
}

/**
 * Virtual / flat list key — must stay stable when optimistic user rows gain runId on run_started.
 * Prefer messageId; user rows without it use timestamp + content fingerprint (not bare length).
 */
export function historyItemStableKey(sessionKey: string, row: DisplayRow, index: number): string {
  const sk = String(sessionKey || 'default')
  const role = String(row.role || 'row')
  const messageId = String(row.messageId || '').trim()
  if (messageId) return `${sk}|mid|${messageId}`

  const ts =
    row.timestamp != null && Number.isFinite(Number(row.timestamp))
      ? String(Math.trunc(Number(row.timestamp)))
      : ''
  const fp = textFingerprint(String(row.text || ''))

  if (role === 'user') {
    // Do not put runId in the key — optimistic send → run_started must keep the same key.
    if (ts) return `${sk}|user|${ts}|${fp}`
    return `${sk}|user|${index}|${fp}`
  }

  const runId = String(row.runId || '').trim()
  // Assistant text grows during stream; fingerprint would remount the row — omit it here.
  if (runId && ts) return `${sk}|${runId}|${role}|${ts}`
  if (runId) return `${sk}|${runId}|${role}`
  if (ts) return `${sk}|${role}|${ts}`
  return `${sk}|${role}|${index}|${fp}`
}

/**
 * React list keys: append #n when base stable keys collide (true duplicate rows).
 * Scroll-anchor lookup should keep using {@link historyItemStableKey} (first match).
 */
export function buildUniqueHistoryItemKeys(
  sessionKey: string,
  items: Array<{ row: DisplayRow; i: number }>,
): string[] {
  const seen = new Map<string, number>()
  return items.map((item) => {
    const base = historyItemStableKey(sessionKey, item.row, item.i)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n === 0 ? base : `${base}#${n}`
  })
}
