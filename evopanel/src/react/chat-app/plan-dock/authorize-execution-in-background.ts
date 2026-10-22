/**
 * REST authorize-execution + local panel/dock updates for start-exec.
 * Extracted from ChatApp.tsx (P44).
 */
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { toast } from '../../../components/toast.js'
import { tasksAPI } from '../../../lib/api-client.js'
import type { ThreadPanelState } from '../../chat-types.js'
import type { PlanDockApiView } from './types.js'

export type AuthorizeExecutionInBackgroundCtx = {
  sessionRef: MutableRefObject<string>
  selectedSessionKey: string
  userAuthorizedTaskIdsRef: MutableRefObject<Set<string>>
  setThreadPanelState: Dispatch<SetStateAction<ThreadPanelState>>
  resolveLangGraphThreadIdForSession: (sessionKey: string) => Promise<string>
  hydrateCollabSidebarSnapshot: (
    threadId: string,
    taskId: string,
  ) => Promise<Record<string, unknown> | null>
  applyTaskProgressSnapshot: (
    snap: Record<string, unknown>,
    opts: { sessionKey: string },
  ) => void
  suppressPlanExecDock: (taskId: string) => void
  applyPlanDockApiView: (view: PlanDockApiView) => void
  planDockApiHide: (
    source: string,
    reason: string,
    extra: Record<string, unknown>,
  ) => PlanDockApiView | Record<string, unknown>
  openCollabExecPanel: (opts?: { clearDismiss?: boolean }) => void
  ensureSubtasksVisibleForTask: (taskId: string) => Promise<void>
}

export async function authorizeExecutionInBackground(
  ctx: AuthorizeExecutionInBackgroundCtx,
  taskId: string,
  _threadIdHint: string,
): Promise<boolean> {
  const tid = String(taskId || '').trim()
  if (!tid) return false
  const sk = String(ctx.sessionRef.current || ctx.selectedSessionKey || '').trim()
  const threadId = await ctx.resolveLangGraphThreadIdForSession(sk)
  try {
    const auth = (await tasksAPI.authorizeTaskExecution(tid, {
      authorized_by: 'user',
      ...(threadId ? { thread_id: threadId } : {}),
    })) as Record<string, unknown>
    if (auth?.success === false) {
      const msg = String(auth?.message || auth?.error || '授权失败').trim()
      toast(`授权失败：${msg}`, 'error')
      return false
    }
    if (threadId) {
      const snap = (await ctx.hydrateCollabSidebarSnapshot(threadId, tid)) as Record<
        string,
        unknown
      > | null
      if (snap) {
        ctx.applyTaskProgressSnapshot(snap, {
          sessionKey: String(ctx.sessionRef.current || ctx.selectedSessionKey || '').trim(),
        })
      }
    }
    const phase = String(auth?.collab_phase || 'awaiting_exec').trim().toLowerCase()
    ctx.setThreadPanelState((prev) => ({
      ...prev,
      boundTaskId: tid,
      collabPhase: phase === 'executing' ? 'executing' : 'awaiting_exec',
      collabTask: {
        ...(prev.collabTask || {}),
        taskId: tid,
        executionAuthorized: true,
        status: phase === 'executing' ? 'executing' : prev.collabTask?.status || 'planned',
      },
    }))
    ctx.suppressPlanExecDock(tid)
    ctx.userAuthorizedTaskIdsRef.current.add(tid)
    ctx.applyPlanDockApiView(
      ctx.planDockApiHide('user_start_execution', 'execution_authorized', {
        taskId: tid,
        taskStatus: phase === 'executing' ? 'executing' : 'planned',
      }) as PlanDockApiView,
    )
    ctx.openCollabExecPanel({ clearDismiss: true })
    await ctx.ensureSubtasksVisibleForTask(tid)
    return true
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    toast(`启动执行失败：${raw}`, 'error')
    return false
  }
}
