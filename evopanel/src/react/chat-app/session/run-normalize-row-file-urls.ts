// @ts-nocheck — mechanical P109 extract.
/**
 * Normalize history/stream file URLs for the active session thread. Extracted (P109).
 */
export type RunNormalizeRowFileUrlsCtx = Record<string, any>

export function runNormalizeRowFileUrlsEffect(ctx: RunNormalizeRowFileUrlsCtx): void {
  const tid = ctx.wsClient.getSessionThreadId(ctx.selectedSessionKey)
  if (!tid) return
  ctx.setRows((prev: any[]) => {
    if (!Array.isArray(prev) || prev.length === 0) return prev
    let touched = false
    const next = prev.map((r: any) => {
      const nr = ctx.normalizeRowFilesInPlace(tid, r)
      if (nr !== r) touched = true
      return nr
    })
    return touched ? next : prev
  })
  // Also normalize current streaming files
  const S = ctx.streamRef.current
  if (S?.turn.files?.length) {
    const nextFiles = S.turn.files.map((f: any) => {
      const url = String(f?.url || '').trim()
      if (!url) return f
      const nextUrl = ctx.normalizeFileHrefForThread(tid, url)
      return nextUrl !== url ? { ...f, url: nextUrl } : f
    })
    S.turn.files = nextFiles
    ctx.scheduleBump()
  }
}
