// @ts-nocheck — mechanical P150 extract.
/**
 * Whether the selected session is live / resume-attaching for chrome.
 * Extracted from ChatApp.tsx (P150).
 */
export type ResolveSelectedSessionLiveCtx = Record<string, any>

export function resolveSelectedSessionLive(ctx: ResolveSelectedSessionLiveCtx): boolean {
  const sk = String(ctx.selectedSessionKey || '').trim()
  if (!sk) return false
  const rt = ctx.getSessionRuntime(sk)
  if (rt.uiTurnSettled && !ctx.isTurnBusy(rt)) return false
  return ctx.isTurnBusy(rt) || ctx.isSessionRuntimeLive(rt)
}

export function resolveIsHomeSurface(ctx: ResolveSelectedSessionLiveCtx): boolean {
  return (
    !ctx.historyLoading &&
    !ctx.historyError &&
    !ctx.sessionHadContent &&
    ctx.renderRows.length === 0 &&
    !ctx.selectedTurnBusy
  )
}

export function resolveSelectedResumeAttach(ctx: ResolveSelectedSessionLiveCtx): boolean {
  const sk = String(ctx.selectedSessionKey || '').trim()
  if (!sk) return false
  const rt = ctx.getSessionRuntime(sk)
  const attach = ctx.deriveAttachState(rt)
  return attach === 'attaching' || attach === 'attached' || rt.turnPhase === 'reattaching'
}

export function resolveSelectedResumeStreamHold(ctx: ResolveSelectedSessionLiveCtx): boolean {
  const sk = String(ctx.selectedSessionKey || '').trim()
  if (!sk) return false
  const rt = ctx.getSessionRuntime(sk)
  return rt.turnPhase === 'reattaching' || ctx.deriveAttachState(rt) === 'attaching'
}

export function resolveSidebarHistory(ctx: ResolveSelectedSessionLiveCtx) {
  const sk = String(ctx.selectedSessionKey || '').trim()
  return Object.values(ctx.sidebarTaskViews)
    .filter((x) => !sk || !x.sessionKey || x.sessionKey === sk)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((x) => x.task)
}
