import type { DisplayRow } from '../chat-types.js'

function rowIdentity(row: DisplayRow | undefined): string {
  if (!row) return ''
  const mid = String(row.messageId || '').trim()
  if (mid) return `id:${mid}`
  const run = String(row.runId || '').trim()
  const role = String(row.role || '').trim()
  const text = String(row.text || '').slice(0, 120)
  return `fallback:${role}:${run}:${text}`
}

/**
 * Soft reopen after painting idle cache: keep longer local history,
 * stitch a newer network page onto the overlapping tail.
 */
export function mergeSoftHistoryFetch(
  current: DisplayRow[],
  fetched: DisplayRow[],
): DisplayRow[] {
  if (!fetched.length) return current.length ? current : fetched
  if (!current.length) return fetched

  const curLast = rowIdentity(current[current.length - 1])
  const fetchLast = rowIdentity(fetched[fetched.length - 1])
  if (curLast && fetchLast && curLast === fetchLast && current.length >= fetched.length) {
    return current
  }

  const firstFetchKey = rowIdentity(fetched[0])
  if (firstFetchKey) {
    const idx = current.findIndex((r) => rowIdentity(r) === firstFetchKey)
    if (idx >= 0) {
      return [...current.slice(0, idx), ...fetched]
    }
  }

  if (current.length > fetched.length) {
    return current
  }
  return fetched
}
