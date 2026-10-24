/**
 * Reset plan latch / collab sidebar UI for session switch or new plan cycle.
 * Extracted from ChatApp.tsx (P76).
 */
import type { Dispatch, SetStateAction } from 'react'
import { invalidatePlanApiCache } from '../../../lib/plan-from-api.js'
import { emptyThreadPanel } from '../thread-panel/state.js'
import type { PlanDockApiView, PlanPanelHit, PlanStreamLatch } from './types.js'
import type { ThreadPanelState } from '../../chat-types.js'

export type ResetCollabPlanUiCtx = {
  sessionRef: { current: string }
  selectedSessionKey: string
  suppressedPlanExecDockKeysRef: { current: Set<string> }
  userAuthorizedTaskIdsRef: { current: Set<string> }
  planAppliedForRef: { current: string }
  planApiSyncInflightRef: { current: Promise<void> | null }
  historyCollabHydratedRef: { current: string }
  historyRowsBootstrappedRef: { current: string }
  planFromApiLoadedRef: { current: string }
  planDockApiViewRef: { current: PlanDockApiView | null }
  threadCollabSnapshotRef: { current: string }
  sessionBoundTaskIdRef: { current: string }
  lastPlanSyncSigRef: { current: string }
  planStreamLatchRef: { current: PlanStreamLatch }
  lastPlanPanelHitRef: { current: PlanPanelHit | null }
  prevCollabExecPhaseRef: { current: string }
  collabExecSessionBaselinedRef: { current: string }
  collabExecDismissedKeysRef: { current: Set<string> }
  resetPlanStreamSession: () => void
  clearSidebarBackfillCaches: () => void
  setPlanExecSuppressVersion: Dispatch<SetStateAction<number>>
  setThreadPanelState: Dispatch<SetStateAction<ThreadPanelState>>
  setPlanDockApiView: (v: PlanDockApiView | null) => void
  setPlanStreamLatched: (v: boolean) => void
  setBoundTaskId: (v: string | null) => void
  setSidebarTaskViews: (v: Record<string, unknown>) => void
  setSidebarSelectedTaskId: (v: string | null) => void
  setHasReceivedTodos: (v: boolean) => void
  setSessionSidebarOpen: (v: boolean) => void
  setCollabExecPanelOpen: (v: boolean) => void
  setKnowledgeMapPanelOpen: (v: boolean) => void
}

/** 切换/新建会话：清空 plan latch、协作侧栏与 suppress，避免串会话显示上一对话的计划/子任务。 */
export function resetCollabPlanUiForSession(
  ctx: ResetCollabPlanUiCtx,
  opts?: { keepBoundTaskId?: boolean; closeSidebar?: boolean },
): void {
  ctx.resetPlanStreamSession()
  ctx.suppressedPlanExecDockKeysRef.current.clear()
  ctx.userAuthorizedTaskIdsRef.current.clear()
  ctx.setPlanExecSuppressVersion((v) => v + 1)
  ctx.setThreadPanelState(emptyThreadPanel())
  ctx.planAppliedForRef.current = ''
  ctx.planApiSyncInflightRef.current = null
  ctx.historyCollabHydratedRef.current = ''
  ctx.historyRowsBootstrappedRef.current = ''
  ctx.planFromApiLoadedRef.current = ''
  ctx.planDockApiViewRef.current = null
  ctx.setPlanDockApiView(null)
  ctx.threadCollabSnapshotRef.current = ''
  ctx.sessionBoundTaskIdRef.current = ''
  const leavingSk = String(ctx.sessionRef.current || ctx.selectedSessionKey || '').trim()
  if (leavingSk) invalidatePlanApiCache(leavingSk)
  if (!opts?.keepBoundTaskId) {
    ctx.setBoundTaskId(null)
  }
  ctx.setSidebarTaskViews({})
  ctx.setSidebarSelectedTaskId(null)
  ctx.setHasReceivedTodos(false)
  ctx.clearSidebarBackfillCaches()
  if (opts?.closeSidebar !== false) {
    ctx.setSessionSidebarOpen(false)
  }
  ctx.setCollabExecPanelOpen(false)
  ctx.setKnowledgeMapPanelOpen(false)
  ctx.prevCollabExecPhaseRef.current = ''
  ctx.collabExecSessionBaselinedRef.current = ''
  ctx.collabExecDismissedKeysRef.current.clear()
}

/** 同会话内开启新一轮 plan：保留会话/thread，清空上一轮 plan/执行侧栏 latch。 */
export function resetCollabPlanUiForNewCycle(ctx: ResetCollabPlanUiCtx): void {
  ctx.resetPlanStreamSession()
  ctx.suppressedPlanExecDockKeysRef.current.clear()
  ctx.userAuthorizedTaskIdsRef.current.clear()
  ctx.setPlanExecSuppressVersion((v) => v + 1)
  ctx.planAppliedForRef.current = ''
  ctx.planApiSyncInflightRef.current = null
  ctx.planFromApiLoadedRef.current = ''
  ctx.lastPlanSyncSigRef.current = ''
  ctx.planStreamLatchRef.current = null
  ctx.setPlanStreamLatched(false)
  ctx.planDockApiViewRef.current = null
  ctx.setPlanDockApiView(null)
  ctx.lastPlanPanelHitRef.current = null
  ctx.setSidebarTaskViews({})
  ctx.setSidebarSelectedTaskId(null)
  ctx.setHasReceivedTodos(false)
  ctx.clearSidebarBackfillCaches()
  const sk = String(ctx.sessionRef.current || ctx.selectedSessionKey || '').trim()
  if (sk) invalidatePlanApiCache(sk)
  ctx.setThreadPanelState(emptyThreadPanel())
  ctx.setBoundTaskId(null)
}
