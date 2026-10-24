// @ts-nocheck — mechanical P106 extract.
/**
 * Clear / maybe-end turn sending state after stream final or stop. Extracted (P106).
 */
export type TurnSendingStateCtx = Record<string, any>

export function clearTurnSendingState(
  ctx: TurnSendingStateCtx,
  sessionKey: string,
  rt: { streamWireSource?: string | null },
  isBackground: boolean,
): void {
  // 必须清 activeChatRunId：否则下一轮 run_started(runId 不同)会被 run gate 阻断，
  // turnPhase 停在 idle，后续 delta 全部被 !streamActive 守卫丢弃，流式显示冻结。
  ctx.clearActiveRun(rt)
  if (!isBackground) ctx.activeChatRunIdRef.current = null
  // SSE final / 停止：POST wire 已关，显式清 marker（TURN_IDLE 会保留 'run' 以免误伤）
  if (rt.streamWireSource === 'run') {
    ctx.markSessionStreamWireSource(sessionKey, null)
  }
  ctx.dispatchSessionRunEnded(sessionKey)
  if (!isBackground) {
    ctx.setStreamHealth(null)
    ctx.streamHealthRef.current = null
  }
}

export function maybeEndTurnSendingState(
  ctx: TurnSendingStateCtx,
  sessionKey: string,
  rt: unknown,
  isBackground: boolean,
  opts: { force?: boolean } = {},
): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  void ctx.maybeClearTurnSendingState({
    sessionKey: sk,
    wsClient: ctx.wsClient,
    force: opts.force,
    onClear: () => {
      clearTurnSendingState(ctx, sk, rt as { streamWireSource?: string | null }, isBackground)
    },
    onResume: () => {
      /* 续流仅用户刷新触发；run 仍 active 时保持 turn busy */
    },
  })
}
