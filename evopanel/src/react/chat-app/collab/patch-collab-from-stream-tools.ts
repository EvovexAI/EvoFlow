/**
 * Patch collab sidebar / plan panel from stream tools (throttled).
 * Extracted from ChatApp.tsx (P82).
 */
import type { Dispatch, SetStateAction } from 'react'
import {
  buildCollabSidebarFromTools,
  isPendingSubtaskKey,
  pruneSupersededPendingSubtasks,
} from '../../../lib/collab-sidebar-from-tools.js'
import { analyzePlanTools } from '../../../lib/plan-pipeline.js'
import { tracePlanPipeline } from '../../../lib/plan-trace.js'
import {
  finalizeCollabSubtasksList,
  mergeCollabSubtasksStable,
} from './subtask-merge.js'
import type {
  CollabSubtaskSnapshot,
  CollabTaskSnapshot,
  SupervisorStepSnapshot,
  ThreadPanelState,
} from '../../chat-types.js'
import type { PlanPanelHit, PlanStreamLatch } from '../plan-dock/types.js'

export type PatchCollabFromStreamToolsOpts = {
  skipPlanPanel?: boolean
  allowAutoOpen?: boolean
  force?: boolean
}

export type PatchCollabFromStreamToolsCtx = {
  patchCollabThrottleRef: { current: number }
  patchCollabPendingOptsRef: { current: PatchCollabFromStreamToolsOpts | undefined }
  patchCollabTimerRef: { current: number }
  lastPlanPanelHitRef: { current: PlanPanelHit | null }
  planStreamLatchRef: { current: PlanStreamLatch }
  planStreamLatched: boolean
  boundTaskId: string | null
  threadPanelState: ThreadPanelState
  collectCollabToolsForSidebar: () => unknown[]
  collectPlanToolsForDetection: () => unknown[]
  syncPlanPanelImmediateFromTools: (tools: unknown[]) => boolean
  setThreadPanelState: Dispatch<SetStateAction<ThreadPanelState>>
  upsertSidebarTaskView: (
    main: CollabTaskSnapshot | null,
    subtasks: CollabSubtaskSnapshot[],
    supervisorSteps: SupervisorStepSnapshot[],
  ) => void
  ensureSubtasksVisibleForTask: (taskId: string) => void | Promise<unknown>
  /** Self-call for deferred flush */
  patchCollabFromStreamTools: (opts?: PatchCollabFromStreamToolsOpts) => void
}

export function patchCollabFromStreamTools(
  ctx: PatchCollabFromStreamToolsCtx,
  opts?: PatchCollabFromStreamToolsOpts,
): void {
  const now = Date.now()
  if (!opts?.force && now - ctx.patchCollabThrottleRef.current < 400) {
    ctx.patchCollabPendingOptsRef.current = opts
    if (!ctx.patchCollabTimerRef.current) {
      ctx.patchCollabTimerRef.current = window.setTimeout(() => {
        ctx.patchCollabTimerRef.current = 0
        ctx.patchCollabThrottleRef.current = Date.now()
        const pending = ctx.patchCollabPendingOptsRef.current
        ctx.patchCollabPendingOptsRef.current = undefined
        ctx.patchCollabFromStreamTools({ ...pending, force: true })
      }, 400)
    }
    return
  }
  if (!opts?.force) ctx.patchCollabThrottleRef.current = now
  const tools = ctx.collectCollabToolsForSidebar()
  const built = buildCollabSidebarFromTools(tools) as {
    main: CollabTaskSnapshot | null
    subtasks: CollabSubtaskSnapshot[]
    supervisorSteps: SupervisorStepSnapshot[]
  }
  if (!opts?.skipPlanPanel) {
    const planTools = ctx.collectPlanToolsForDetection()
    const planChanged = ctx.syncPlanPanelImmediateFromTools(planTools)
    if (planChanged) {
      const patchAnalyzed = analyzePlanTools(planTools)
      tracePlanPipeline('patch', planTools, {
        planHit: patchAnalyzed.hit || ctx.lastPlanPanelHitRef.current,
        collabPhase: ctx.threadPanelState.collabPhase,
        collabTask: ctx.threadPanelState.collabTask,
        planInputFallback: ctx.threadPanelState.planInputFallback,
        subtaskCount: ctx.threadPanelState.collabSubtasks?.length ?? 0,
        isSuppressed: false,
        streamPlanLatched: ctx.planStreamLatched || !!ctx.planStreamLatchRef.current,
        latchedPlanInput: ctx.planStreamLatchRef.current?.planInput || null,
      })
    }
  }

  const hasAny =
    !!(built.main?.taskId && String(built.main.taskId).trim()) ||
    built.subtasks.length > 0 ||
    built.supervisorSteps.length > 0
  if (!hasAny) return
  if (built.main?.taskId || built.subtasks.length || built.supervisorSteps.length) {
    ctx.setThreadPanelState((prev) => {
      const incomingTaskId = (built.main?.taskId || '').trim()
      const prevTaskId = (prev.collabTask?.taskId || '').trim()
      const switchedTask = !!incomingTaskId && !!prevTaskId && incomingTaskId !== prevTaskId
      return {
        ...prev,
        ...(built.main?.taskId
          ? {
              boundTaskId: built.main.taskId,
              collabTask: {
                ...(switchedTask ? {} : prev.collabTask || {}),
                ...built.main,
                ...(prev.collabTask?.status === 'planned' && !built.main?.status
                  ? { status: 'planned' }
                  : {}),
                ...(prev.collabTask?.boundPlanReady && !built.main?.boundPlanReady
                  ? { boundPlanReady: true }
                  : {}),
              } as CollabTaskSnapshot,
            }
          : {}),
        ...(built.subtasks.length
          ? {
              collabSubtasks: finalizeCollabSubtasksList(
                mergeCollabSubtasksStable(
                  pruneSupersededPendingSubtasks(
                    switchedTask ? [] : prev.collabSubtasks || [],
                    built.subtasks,
                  ),
                  built.subtasks,
                ),
                prev.subagentTasks,
              ),
            }
          : switchedTask
            ? { collabSubtasks: [] }
            : {}),
        ...(built.supervisorSteps.length
          ? { supervisorSteps: built.supervisorSteps }
          : switchedTask
            ? { supervisorSteps: [] }
            : {}),
      }
    })
    ctx.upsertSidebarTaskView(built.main || null, built.subtasks, built.supervisorSteps)
  }
  const mainTid = String(
    built.main?.taskId || ctx.threadPanelState.collabTask?.taskId || ctx.boundTaskId || '',
  ).trim()
  const createdSubtaskAction = (built.supervisorSteps || []).some((s) => {
    const a = String((s as { action?: string })?.action || '').trim()
    return a === 'create_task_with_subtasks' || a === 'create_subtasks' || a === 'create_subtask'
  })
  const hasPendingPlaceholders = built.subtasks.some((s) => isPendingSubtaskKey(s.subtaskId))
  if (mainTid && (hasPendingPlaceholders || (createdSubtaskAction && built.subtasks.length === 0))) {
    void ctx.ensureSubtasksVisibleForTask(mainTid)
  }
}
