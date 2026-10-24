/**
 * Shell single-session refresh: history reload + optional stream resume + plan sync.
 * Extracted from ChatApp.tsx (P46).
 */
import type { MutableRefObject } from 'react'
import {
  getSessionRuntime,
  isSessionRuntimeLive,
  dispatchSessionTurnEvent,
  isTurnBusy,
} from '../../lib/session-runtime-store.js'
import { srLog } from '../../lib/stream-resume-debug.js'
import { logStreamStop } from '../../lib/stream-stop-log.js'
import {
  shouldManualRefreshResumeStream,
  shouldSuppressAutoReattach,
} from '../../lib/stream-resume-gate.js'
import {
  clearSessionExecutionProbe,
  fetchAndCacheSessionExecutionState,
} from '../../lib/session-execution/index.js'
import { invalidatePlanApiCache } from '../../../lib/plan-from-api.js'
import {
  collectAssistantToolArraysFromRows,
  extractLastPlanToolSuccessFromArrays,
} from '../../../lib/collab-sidebar-from-tools.js'
import type { DisplayRow } from '../../chat-types.js'

export type RunShellSessionRefreshCtx = {
  sessionRefreshInFlightRef: MutableRefObject<string>
  sessionTasksFetchSeqRef: MutableRefObject<number>
  sessionsRef: MutableRefObject<Array<{ sessionKey?: string; runStatus?: string; currentRunId?: string | null }>>
  executingSessionKeysRef: MutableRefObject<Set<string>>
  planAppliedForRef: MutableRefObject<string>
  planFromApiLoadedRef: MutableRefObject<string>
  threadCollabSnapshotRef: MutableRefObject<string>
  planSessionEnterRef: MutableRefObject<string>
  rowsRef: MutableRefObject<DisplayRow[]>
  rows: DisplayRow[]
  boundTaskId: string | null
  refreshSessionsRef: MutableRefObject<
    ((opts?: { skipAutoReselect?: boolean }) => Promise<void> | void) | null | undefined
  >
  requestManualStreamResumeRef: MutableRefObject<
    (sk: string, opts?: { refreshSessions?: boolean }) => void
  >
  refreshGoalStatusRef: MutableRefObject<((sk: string) => void) | null | undefined>
  isActiveSessionFetch: (sessionKey: string, fetchSeq: number) => boolean
  reloadHistoryFromDb: (opts?: {
    bypassCache?: boolean
    dbOnly?: boolean
    anchorRunId?: string | null
  }) => Promise<unknown>
  syncPlanPanelFromApi: (opts: any) => Promise<void>
  abortStreamWire: (sk: string, runId: string) => void
  getSessionContext: (sk: string) => { collab_task_id?: string } | undefined
}

export async function runShellSessionRefresh(
  ctx: RunShellSessionRefreshCtx,
  sessionKey: string,
): Promise<void> {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  if (ctx.sessionRefreshInFlightRef.current === sk) return
  ctx.sessionRefreshInFlightRef.current = sk
  const fetchSeq = ctx.sessionTasksFetchSeqRef.current
  try {
    if (!ctx.isActiveSessionFetch(sk, fetchSeq)) return

    // 先刷新会话列表，获取最新 runStatus（续流门禁依赖此数据）
    await ctx.refreshSessionsRef.current?.({ skipAutoReselect: true })
    if (!ctx.isActiveSessionFetch(sk, fetchSeq)) return

    if (sk) {
      invalidatePlanApiCache(sk)
    }

    ctx.planAppliedForRef.current = ''
    ctx.planFromApiLoadedRef.current = ''
    ctx.threadCollabSnapshotRef.current = ''

    const rowBefore = ctx.sessionsRef.current.find((s) => String(s.sessionKey || '') === sk)
    const rtBefore = getSessionRuntime(sk)
    const suppressLivePost = shouldSuppressAutoReattach({
      sessionKey: sk,
      runtime: rtBefore,
    })
    const shouldResumeBefore =
      !suppressLivePost &&
      shouldManualRefreshResumeStream({
        sessionKey: sk,
        runStatus: rowBefore?.runStatus,
        executingSessionKeys: ctx.executingSessionKeysRef.current,
        runtime: rtBefore,
      })
    if (shouldResumeBefore) {
      const runId = String(rtBefore.activeChatRunId || rowBefore?.currentRunId || '').trim()
      if (runId) ctx.abortStreamWire(sk, runId)
      dispatchSessionTurnEvent(sk, {
        type: 'REATTACH_STARTED',
        runId: runId || '',
      })
    }

    await ctx.reloadHistoryFromDb({ bypassCache: true, dbOnly: true })
    if (!ctx.isActiveSessionFetch(sk, fetchSeq)) return

    const row = ctx.sessionsRef.current.find((s) => String(s.sessionKey || '') === sk)
    const rt = getSessionRuntime(sk)
    const shouldResume =
      shouldResumeBefore ||
      shouldManualRefreshResumeStream({
        sessionKey: sk,
        runStatus: row?.runStatus,
        executingSessionKeys: ctx.executingSessionKeysRef.current,
        runtime: rt,
      })
    srLog('shell session refresh', { sessionKey: sk, shouldResume, runStatus: row?.runStatus ?? null })
    if (shouldResume) {
      ctx.requestManualStreamResumeRef.current(sk, { refreshSessions: false })
    } else {
      // shouldResume=false：会话可能已结束但 probe cache/runtime 仍 stale。
      // 主动查后端 execution/state 同步 probe cache，若已结束则清理本地运行状态。
      try {
        const probe = await fetchAndCacheSessionExecutionState(sk)
        const rtAfter = getSessionRuntime(sk)
        if (rtAfter.streamWireSource === 'run') {
          // live POST 未关：probe 滞后不得清 busy
        } else {
          const stillBusy = isTurnBusy(rtAfter) || isSessionRuntimeLive(rtAfter)
          const backendDone = probe ? !probe.executing && !probe.goalActive : true
          if (stillBusy && backendDone) {
            // 后端确认已结束：清 probe cache + dispatch TURN_IDLE 归位侧栏运行状态
            logStreamStop({
              sessionKey: sk,
              runId: rtAfter.activeChatRunId || rtAfter.stream.runId,
              trigger: 'refresh_backend_done',
              hasEndMarker: false,
              detail: {
                source: 'shell_session_refresh',
                turnPhase: rtAfter.turnPhase,
                probeExecuting: probe?.executing,
                probeGoalActive: probe?.goalActive,
              },
            })
            clearSessionExecutionProbe(sk)
            dispatchSessionTurnEvent(sk, { type: 'TURN_IDLE' })
          }
        }
      } catch {
        /* best-effort */
      }
    }

    // 刷新目标状态（与续流独立，确保目标图标/步数/目标状态同步）
    void ctx.refreshGoalStatusRef.current?.(sk)

    const rowsForPlan = ctx.rowsRef.current.length ? ctx.rowsRef.current : ctx.rows
    const planHit = rowsForPlan.length
      ? extractLastPlanToolSuccessFromArrays(collectAssistantToolArraysFromRows(rowsForPlan))
      : null
    const sessionCtx = ctx.getSessionContext(sk) as { collab_task_id?: string } | undefined
    const preferTaskId = String(
      sessionCtx?.collab_task_id ||
        (planHit as { taskId?: string } | null)?.taskId ||
        ctx.boundTaskId ||
        '',
    ).trim()

    const syncOpts = {
      source: 'session_refresh' as const,
      sessionKey: sk,
      hintTaskId: preferTaskId,
      bypassCache: true,
      fallback: (planHit as { planInput?: Record<string, unknown> } | null)?.planInput ?? null,
      planOutput: (planHit as { planOutput?: Record<string, unknown> } | null)?.planOutput ?? null,
      boundPlanReady: !!(planHit as { boundPlanReady?: boolean } | null)?.boundPlanReady,
    }
    await ctx.syncPlanPanelFromApi(syncOpts)
    ctx.planSessionEnterRef.current = sk
  } finally {
    if (ctx.sessionRefreshInFlightRef.current === sk) ctx.sessionRefreshInFlightRef.current = ''
  }
}
