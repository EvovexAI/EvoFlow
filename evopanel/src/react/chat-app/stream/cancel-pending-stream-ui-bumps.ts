// @ts-nocheck — mechanical P139 extract.
/**
 * Cancel coalesced stream/reasoning/worker/chrome UI bump timers.
 * Extracted from ChatApp.tsx (P139).
 */
export type CancelPendingStreamUiBumpsCtx = Record<string, any>

export function cancelPendingStreamUiBumps(ctx: CancelPendingStreamUiBumpsCtx): void {
  ctx.streamBumpSchedulerRef.current?.cancelPending?.()
  ctx.reasoningBumpSchedulerRef.current?.cancelPending?.()
  ctx.workerFileBumpSchedulerRef.current?.cancelPending?.()
  if (ctx.streamChromeBumpTimerRef.current) {
    clearTimeout(ctx.streamChromeBumpTimerRef.current)
    ctx.streamChromeBumpTimerRef.current = 0
  }
  ctx.streamChromeBumpPendingRef.current = false
}
