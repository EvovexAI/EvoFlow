// @ts-nocheck — mechanical P107 extract.
/**
 * Lazily create stream / worker / reasoning / bg-notify bump schedulers. Extracted (P107).
 */
export type EnsureStreamBumpSchedulersCtx = Record<string, any>

export function ensureStreamBumpSchedulers(ctx: EnsureStreamBumpSchedulersCtx): void {
  if (
    !ctx.streamBumpSchedulerRef.current ||
    typeof ctx.streamBumpSchedulerRef.current.cancelPending !== 'function'
  ) {
    ctx.streamBumpSchedulerRef.current?.dispose()
    ctx.streamBumpSchedulerRef.current = ctx.createStreamBumpScheduler(
      () => ctx.onCoalescedStreamBumpRef.current(),
      () => ctx.streamBumpMinIntervalRef.current,
    )
  }
  if (
    !ctx.workerFileBumpSchedulerRef.current ||
    typeof ctx.workerFileBumpSchedulerRef.current.cancelPending !== 'function'
  ) {
    ctx.workerFileBumpSchedulerRef.current?.dispose()
    ctx.workerFileBumpSchedulerRef.current = ctx.createStreamBumpScheduler(
      () => ctx.onCoalescedStreamBumpRef.current(),
      () => (ctx.isStreamThrottleEnabled() ? 400 : ctx.STREAM_BUMP_INTERVAL_MS),
    )
  }
  if (
    !ctx.reasoningBumpSchedulerRef.current ||
    typeof ctx.reasoningBumpSchedulerRef.current.cancelPending !== 'function'
  ) {
    ctx.reasoningBumpSchedulerRef.current?.dispose()
    ctx.reasoningBumpSchedulerRef.current = ctx.createStreamBumpScheduler(
      () => ctx.onCoalescedStreamBumpRef.current(),
      () => ctx.STREAM_REASONING_BUMP_INTERVAL_MS,
    )
  }
  if (
    !ctx.bgRuntimeNotifySchedulerRef.current ||
    typeof ctx.bgRuntimeNotifySchedulerRef.current.cancelPending !== 'function'
  ) {
    ctx.bgRuntimeNotifySchedulerRef.current?.dispose()
    ctx.bgRuntimeNotifySchedulerRef.current = ctx.createStreamBumpScheduler(
      () => {
        let sk = String(ctx.bgRuntimeNotifySessionRef.current || '').trim()
        if (!sk && !ctx.chatSurfaceVisibleRef.current) {
          sk = String(ctx.sessionRef.current || '').trim()
        }
        if (sk) ctx.bumpSessionRuntimeNotifyForKey(sk)
      },
      () =>
        ctx.isChatOverlayDeferActive()
          ? ctx.STREAM_OVERLAY_DEFER_RUNTIME_NOTIFY_MS
          : ctx.STREAM_BG_RUNTIME_NOTIFY_MS,
    )
  }
}

export function disposeStreamBumpSchedulers(ctx: EnsureStreamBumpSchedulersCtx): void {
  ctx.streamBumpSchedulerRef.current?.dispose()
  ctx.workerFileBumpSchedulerRef.current?.dispose()
  ctx.reasoningBumpSchedulerRef.current?.dispose()
  ctx.bgRuntimeNotifySchedulerRef.current?.dispose()
  if (ctx.streamChromeBumpTimerRef.current) {
    clearTimeout(ctx.streamChromeBumpTimerRef.current)
    ctx.streamChromeBumpTimerRef.current = 0
  }
}
