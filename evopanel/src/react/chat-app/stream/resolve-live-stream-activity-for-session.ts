// @ts-nocheck — mechanical P127 extract.
/**
 * Resolve composer-dock activity for a session list / selected row.
 * Extracted from ChatApp.tsx (P127).
 */
export type ResolveLiveStreamActivityForSessionCtx = Record<string, any>

export function resolveLiveStreamActivityForSession(
  ctx: ResolveLiveStreamActivityForSessionCtx,
  sessionKey: string,
  isSelectedRow: boolean,
) {
  const sk = String(sessionKey || '').trim()
  if (!sk) return null
  const sessionRow = ctx.sessionsRef.current.find((s) => String(s.sessionKey || '') === sk)
  const executing = ctx.isSessionExecuting(sk, { sessionRow })
  if (!executing) return null
  const rt = ctx.getSessionRuntime(sk)
  const selectedSk = String(ctx.selectedSessionKey || '').trim()
  const useForegroundStream = isSelectedRow && sk === selectedSk
  const panel = useForegroundStream
    ? ctx.threadPanelStateRef.current
    : ctx.threadPanelBySessionRef.current.get(sk) || ctx.emptyThreadPanel()
  const streamTurn = useForegroundStream ? ctx.streamRef.current.turn : rt.stream.turn
  const elapsedSec = ctx.computeTurnElapsedSec(sessionRow, {
    fallbackStartMs: rt.turnStartTs,
  })
  return ctx.resolveComposerDockActivity({
    activityKind: rt.activity.kind !== 'idle' ? rt.activity.kind : panel.activityKind,
    activityDetail: rt.activity.detail || panel.activityDetail,
    streamSystemActivity: streamTurn.systemActivity,
    streamSystemActivityKind: streamTurn.systemActivityKind,
    elapsedSec,
    activeTurn: executing,
  })
}
