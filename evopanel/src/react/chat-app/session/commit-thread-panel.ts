// @ts-nocheck — mechanical P114 extract.
/**
 * Commit thread panel state for active or background session. Extracted (P114).
 */
export type CommitThreadPanelCtx = Record<string, any>

export function commitThreadPanelForSession(
  ctx: CommitThreadPanelCtx,
  sessionKey: string,
  updater: (prev: unknown) => unknown,
): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  const activeSk = String(ctx.sessionRef.current || ctx.selectedSessionKey || '').trim()
  if (sk === activeSk) {
    ctx.setThreadPanelState((prev: unknown) => {
      const next = updater(prev)
      if (next !== prev) ctx.threadPanelBySessionRef.current.set(sk, next)
      return next
    })
    return
  }
  const prev = ctx.threadPanelBySessionRef.current.get(sk) || ctx.emptyThreadPanel()
  const next = updater(prev)
  if (next === prev) return
  ctx.threadPanelBySessionRef.current.set(sk, next)
}
