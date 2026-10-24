// @ts-nocheck — mechanical P101 extract.
/**
 * Stream UI bump schedulers (live / reasoning / overlay-deferred). Extracted (P101).
 */
export type ScheduleStreamBumpsCtx = Record<string, any>

export function createScheduleBump(ctx: ScheduleStreamBumpsCtx) {
  return (opts?: { immediate?: boolean }) => {
    if (
      ctx.chatStreamBgApplyRef.current ||
      ctx.isChatOverlayDeferActive() ||
      !ctx.chatSurfaceVisibleRef.current
    ) {
      if (opts?.immediate) {
        ctx.bgRuntimeNotifySchedulerRef.current?.cancelPending?.()
        let sk = String(ctx.bgRuntimeNotifySessionRef.current || '').trim()
        if (!sk && !ctx.chatSurfaceVisibleRef.current) {
          sk = String(ctx.sessionRef.current || '').trim()
        }
        if (sk) ctx.bumpSessionRuntimeNotifyForKey(sk, { immediate: true })
      } else {
        ctx.bgRuntimeNotifySchedulerRef.current?.schedule(opts)
      }
      return
    }
    if (opts?.immediate) {
      ctx.streamBumpSchedulerRef.current?.cancelPending?.()
      ctx.reasoningBumpSchedulerRef.current?.cancelPending?.()
      // 流式写进度 / tool 标签更新：沿 session-runtime 通知（替代旧 streamDisplayTick）。
      const targetSk = String(ctx.streamRefKeyRef.current || ctx.sessionRef.current || '').trim()
      if (targetSk) ctx.bumpSessionRuntimeNotifyForKey(targetSk, { immediate: true })
      return
    }
    const throttleFloor = ctx.isStreamThrottleEnabled()
      ? ctx.resolveStreamBumpMinIntervalMs(ctx.streamRef.current)
      : ctx.STREAM_BUMP_INTERVAL_MS
    const nextInterval = Math.max(ctx.STREAM_BUMP_INTERVAL_MS, throttleFloor)
    const prevInterval = ctx.streamBumpMinIntervalRef.current
    ctx.streamBumpMinIntervalRef.current = nextInterval
    if (nextInterval !== prevInterval) {
      ctx.streamPerfNoteBumpThrottle(nextInterval, prevInterval)
    }
    ctx.streamBumpSchedulerRef.current?.schedule(opts)
  }
}

export function createScheduleReasoningBump(ctx: ScheduleStreamBumpsCtx) {
  return (opts?: { immediate?: boolean }) => {
    if (
      ctx.chatStreamBgApplyRef.current ||
      ctx.isChatOverlayDeferActive() ||
      !ctx.chatSurfaceVisibleRef.current
    ) {
      if (opts?.immediate) {
        ctx.bgRuntimeNotifySchedulerRef.current?.cancelPending?.()
        let sk = String(ctx.bgRuntimeNotifySessionRef.current || '').trim()
        if (!sk && !ctx.chatSurfaceVisibleRef.current) {
          sk = String(ctx.sessionRef.current || '').trim()
        }
        if (sk) ctx.bumpSessionRuntimeNotifyForKey(sk, { immediate: true })
      } else {
        ctx.bgRuntimeNotifySchedulerRef.current?.schedule(opts)
      }
      return
    }
    if (opts?.immediate) {
      ctx.reasoningBumpSchedulerRef.current?.cancelPending?.()
      ctx.streamBumpSchedulerRef.current?.cancelPending?.()
      // 写进度 / tool 标签更新：会话级通知驱动 MessageVirtualList 重算
      const targetSk = String(ctx.streamRefKeyRef.current || ctx.sessionRef.current || '').trim()
      if (targetSk) ctx.bumpSessionRuntimeNotifyForKey(targetSk, { immediate: true })
      return
    }
    ctx.reasoningBumpSchedulerRef.current?.schedule(opts)
  }
}
