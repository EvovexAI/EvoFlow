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
  opts?: { keepStreamPin?: boolean },
): DisplayRow[] {
  if (!fetched.length) return current.length ? current : fetched
  if (!current.length) return fetched

  // v5.10：本地正在流式时，尾部的 _stream pin 行绝不能被 fetched（DB 视图）替换掉
  // —— 否则流式气泡消失/折叠，直到下个 SSE 帧才恢复。空闲会话（keepStreamPin=false）
  // 不补 pin，避免把陈旧 pin 永久带回。
  const trailingPin: DisplayRow[] = []
  if (opts?.keepStreamPin) {
    const curLast = current[current.length - 1]
    if (curLast?.role === '_stream') trailingPin.push(curLast)
  }

  const curLastKey = rowIdentity(curLast)
  const fetchLast = rowIdentity(fetched[fetched.length - 1])
  if (curLastKey && fetchLast && curLastKey === fetchLast && current.length >= fetched.length) {
    return current
  }

  const base = (() => {
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
  })()

  // base 尾部若已含 pin（fetched 自己带了）就不重复补
  const baseHasPin = base.length > 0 && base[base.length - 1]?.role === '_stream'
  if (trailingPin.length && !baseHasPin) {
    return [...base, ...trailingPin]
  }
  return base
}
