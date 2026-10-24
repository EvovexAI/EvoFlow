// @ts-nocheck — mechanical P100 extract.
/**
 * useGoalMode host callbacks. Extracted from ChatApp.tsx (P100).
 */
export type GoalModeCallbacksCtx = Record<string, any>

export function createOnGoalRunningChange(ctx: GoalModeCallbacksCtx) {
  return (running: boolean, sessionKey: string) => {
    const sk = String(sessionKey || '').trim()
    if (!sk) return
    if (String(ctx.sessionRef.current || '').trim() === sk) {
      ctx.setLiveTurnAssistantRunId(null)
    }
  }
}

export function createOnGoalSendingChange(ctx: GoalModeCallbacksCtx) {
  return (sending: boolean) => {
    const sk = String(ctx.selectedSessionKey || '').trim()
    if (!sk || String(ctx.sessionRef.current || '').trim() !== sk) return
    if (sending) {
      // 用户主动再发：清 stop 后的 recovery cooldown，避免新一轮 AG-UI 被丢弃
      ctx.clearStreamReattachCooldown(sk)
      ctx.resetStreamStopLogDedupe(sk)
      ctx.dispatchSessionTurnEvent(sk, { type: 'SEND_STARTED', turnStartTs: Date.now() })
    } else {
      ctx.dispatchSessionRunEnded(sk)
    }
  }
}

export function createOnRefreshChatHistory(ctx: GoalModeCallbacksCtx) {
  return async () => {
    const sk = String(ctx.sessionRef.current || '').trim()
    await ctx.reloadHistoryFromDb({ bypassCache: true, dbOnly: true })
    if (!sk) return
    // 同步后端 execution/state：若 run 已结束但前端仍显示运行中，归位状态
    try {
      const probe = await ctx.fetchAndCacheSessionExecutionState(sk)
      const rt = ctx.getSessionRuntime(sk)
      // live POST 未关：probe 滞后不得清 busy（与 shell refresh / RUN_FINISHED 同病）
      if (ctx.isLivePostStreamOpen(rt)) return
      const stillBusy = ctx.isTurnBusy(rt) || ctx.isSessionRuntimeLive(rt)
      const backendDone = probe ? !probe.executing && !probe.goalActive : true
      if (stillBusy && backendDone) {
        ctx.logStreamStop({
          sessionKey: sk,
          runId: rt.activeChatRunId || rt.stream.runId,
          trigger: 'refresh_backend_done',
          hasEndMarker: false,
          detail: {
            source: 'goal_refresh_chat_history',
            turnPhase: rt.turnPhase,
            probeExecuting: probe?.executing,
            probeGoalActive: probe?.goalActive,
          },
        })
        ctx.clearSessionExecutionProbe(sk)
        ctx.dispatchSessionTurnEvent(sk, { type: 'TURN_IDLE' })
      }
    } catch {
      /* best-effort */
    }
  }
}
