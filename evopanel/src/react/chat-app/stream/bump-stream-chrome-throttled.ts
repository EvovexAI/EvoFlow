// @ts-nocheck — mechanical P135 extract.
/**
 * Throttle session-runtime chrome bumps during stream (overlay / stream throttle aware).
 * Extracted from ChatApp.tsx (P135).
 */
export type BumpStreamChromeThrottledCtx = Record<string, any>

export function bumpStreamChromeThrottled(ctx: BumpStreamChromeThrottledCtx): void {
  const sk = String(ctx.streamRefKeyRef.current || ctx.sessionRef.current || '').trim()
  if (!sk) return
  ctx.streamChromeBumpPendingRef.current = true
  const minInterval = ctx.isChatOverlayDeferActive()
    ? ctx.STREAM_OVERLAY_DEFER_CHROME_MS
    : ctx.isStreamThrottleEnabled()
      ? ctx.STREAM_CHROME_BUMP_MS
      : ctx.STREAM_BUMP_INTERVAL_MS
  const elapsed = Date.now() - ctx.streamChromeLastBumpRef.current
  if (elapsed >= minInterval) {
    ctx.streamChromeBumpPendingRef.current = false
    ctx.streamChromeLastBumpRef.current = Date.now()
    ctx.bumpSessionRuntimeNotifyForKey(sk, { immediate: true })
    return
  }
  if (ctx.streamChromeBumpTimerRef.current) return
  ctx.streamChromeBumpTimerRef.current = window.setTimeout(() => {
    ctx.streamChromeBumpTimerRef.current = 0
    if (!ctx.streamChromeBumpPendingRef.current) return
    ctx.streamChromeBumpPendingRef.current = false
    ctx.streamChromeLastBumpRef.current = Date.now()
    ctx.bumpSessionRuntimeNotifyForKey(sk, { immediate: true })
  }, minInterval - elapsed)
}
