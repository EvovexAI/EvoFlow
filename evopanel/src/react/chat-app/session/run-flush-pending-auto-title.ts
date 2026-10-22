// @ts-nocheck — mechanical P123 extract.
/**
 * After stream goes idle, flush delayed auto session title for the bound key.
 * Extracted from ChatApp.tsx (P123).
 */
export type RunFlushPendingAutoTitleCtx = Record<string, any>

export function runFlushPendingAutoTitleEffect(ctx: RunFlushPendingAutoTitleCtx): void {
  const pending = ctx.pendingAutoSessionTitleRef.current
  if (!pending?.sessionKey || !pending.title) return
  const pendingRt = ctx.getSessionRuntime(pending.sessionKey)
  const pendingStreaming =
    ctx.isTurnBusy(pendingRt) ||
    ctx.streamRefHasVisibleContent(pendingRt.stream) ||
    (String(ctx.sessionRef.current || '').trim() === pending.sessionKey &&
      (ctx.streamRefHasVisibleContent(ctx.streamRef.current) || ctx.selectedTurnBusy))
  if (pendingStreaming) return
  ctx.pendingAutoSessionTitleRef.current = null
  ctx.persistSessionTitleIfMissing(pending.sessionKey, pending.title)
}
