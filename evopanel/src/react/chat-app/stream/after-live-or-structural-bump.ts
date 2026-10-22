// @ts-nocheck — mechanical P102 extract.
/**
 * After stream commit: schedule live/structural UI bumps. Extracted (P102).
 */
export type AfterLiveOrStructuralBumpCtx = Record<string, any>

export function afterLiveOrStructuralBump(
  ctx: AfterLiveOrStructuralBumpCtx,
  sessionKey: string,
  stream: unknown,
  opts: { liveTextOnly: boolean; immediate?: boolean; reasoning?: boolean },
): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  const skipLiveUi =
    ctx.chatStreamBgApplyRef.current || !ctx.chatSurfaceVisibleRef.current
  // 整块替换 + 递增 seq：作为「事实存储」，下游 React 端由 session-runtime
  // notify（scheduleBump 触发）单链路到达，避免双路通知造成每条 SSE delta
  // 触发两次 React rerender，从而消除 MessageVirtualList / MessageRow 闪烁。
  ctx.streamSeqRef.current += 1
  ctx.commitStreamSnapshot(sk, stream, { seq: ctx.streamSeqRef.current })
  if (opts.liveTextOnly) {
    if (skipLiveUi) return
    // Keep every delta in the committed snapshot, but coalesce paints to one
    // low-latency frame. Immediate React updates per token starve the main
    // thread and make both reasoning and body text appear to stutter.
    ctx.streamBumpSchedulerRef.current?.schedule({ lowLatency: true })
    return
  }
  // structural 变化：新 tool / 新 image / 新 segment 出现。
  if (opts.immediate) {
    ctx.scheduleBump({ immediate: true })
    return
  }
  if (skipLiveUi) {
    ctx.scheduleBump()
    return
  }
  ctx.scheduleBump()
}
