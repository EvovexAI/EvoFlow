/**
 * Build PlanExecConfirmAnchor from plan dock API view.
 * Extracted from ChatApp.tsx (P62).
 */
import type { PlanExecConfirmAnchor } from '../../components/ToolCallList.js'
import { findLastSuccessfulPlanToolCallId } from '../../../lib/collab-sidebar-from-tools.js'
import { planDockApiHide } from '../../../lib/plan-dock-api.js'
import type { PlanDockApiView } from './types.js'

export type BuildPlanExecConfirmAnchorCtx = {
  planDockApiView: PlanDockApiView | null
  planExecToolArrays: unknown[][]
  planExecStarting: boolean
  selectedSessionKey: string
  runUserExecutionStart: (taskId: string) => void
  suppressPlanExecDock: (taskId: string) => void
  userAuthorizedTaskIdsRef: { current: Set<string> }
  applyPlanDockApiView: (view: PlanDockApiView) => void
}

export function buildPlanExecConfirmAnchor(
  ctx: BuildPlanExecConfirmAnchorCtx,
): PlanExecConfirmAnchor | null {
  if (!ctx.planDockApiView?.show) return null
  const view = ctx.planDockApiView
  const sk = String(ctx.selectedSessionKey || '').trim()
  const toolCallId =
    findLastSuccessfulPlanToolCallId(ctx.planExecToolArrays) || view.toolCallId || ''
  return {
    anchorToolCallId: toolCallId,
    taskId: view.taskId,
    taskName: view.taskName,
    subtaskCount: view.subtaskCount,
    planTitle: view.planStructured.goal,
    planStructuredFallback: view.planStructured,
    syncedSubtasks: undefined,
    sessionKey: sk || undefined,
    showStartExecution: view.showStartExecution,
    statusLabel: view.statusLabel,
    skipApiFetch: true,
    busy: ctx.planExecStarting,
    onStartExecution: (startTaskId) => {
      const tid = String(startTaskId || view.taskId || '').trim()
      void ctx.runUserExecutionStart(tid)
    },
    onDismiss: (dismissTaskId) => {
      const tid = String(dismissTaskId || view.taskId || '').trim()
      if (!tid) return
      ctx.suppressPlanExecDock(tid)
      ctx.userAuthorizedTaskIdsRef.current.add(tid)
      ctx.applyPlanDockApiView(
        planDockApiHide('user_dismiss', 'manually_dismissed', {
          taskId: tid,
          taskStatus: view.taskStatus,
        }) as PlanDockApiView,
      )
    },
  }
}
