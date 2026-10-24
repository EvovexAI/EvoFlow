/**
 * Immediate plan-panel write from streaming/history tools.
 * Extracted from ChatApp.tsx (P15).
 */
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { analyzePlanTools } from '../../../lib/plan-pipeline.js'
import { planStructuredStepCount } from '../../../lib/plan-from-task.js'
import type { PlanPanelHit, PlanStreamLatch } from './types.js'
import type { CollabTaskSnapshot, ThreadPanelState } from '../../chat-types.js'

export type SyncPlanPanelImmediateCtx = {
  planStreamLatchRef: MutableRefObject<PlanStreamLatch>
  lastPlanDetectionToolsRef: MutableRefObject<unknown[]>
  lastPlanPanelHitRef: MutableRefObject<PlanPanelHit | null>
  lastPlanSyncSigRef: MutableRefObject<string>
  setPlanStreamLatched: Dispatch<SetStateAction<boolean>>
  setThreadPanelState: Dispatch<SetStateAction<ThreadPanelState>>
  absorbPlanFromTools: (tools: unknown[]) => void
  publishPlanPanelHit: (hit: PlanPanelHit | null) => void
  resetCollabPlanUiForNewCycle: () => void
}

/** plan 工具入参/出参一到就立刻写 panel state（不等到 final / 刷新）。 */
export function syncPlanPanelImmediateFromTools(
  ctx: SyncPlanPanelImmediateCtx,
  tools: unknown[],
): boolean {
  ctx.absorbPlanFromTools(tools)
  const analyzed = analyzePlanTools(tools)
  if (analyzed.planRows.length > 0) {
    ctx.lastPlanDetectionToolsRef.current = tools
    if (!ctx.planStreamLatchRef.current) {
      ctx.planStreamLatchRef.current = {
        planInput: analyzed.hit?.planInput,
        boundPlanReady: analyzed.hit?.boundPlanReady,
        taskId: analyzed.hit?.taskId,
      }
      ctx.setPlanStreamLatched(true)
    }
  }
  const hit = analyzed.hit
  if (hit?.newPlanCycle) {
    ctx.resetCollabPlanUiForNewCycle()
  }
  if (!hit?.planInput && !hit?.boundPlanReady) return false
  const goal = String(hit?.planInput?.goal || '').trim()
  const stepN = Array.isArray(hit?.planInput?.steps) ? hit.planInput.steps.length : 0
  const sig = `${hit?.boundPlanReady ? 'out' : 'in'}:${hit?.taskId || ''}:${goal}:${stepN}`
  const prevStepN = planStructuredStepCount(ctx.lastPlanPanelHitRef.current?.planInput)
  if (sig === ctx.lastPlanSyncSigRef.current && stepN <= prevStepN) return false
  ctx.lastPlanSyncSigRef.current = sig
  ctx.publishPlanPanelHit(hit as PlanPanelHit)
  ctx.lastPlanDetectionToolsRef.current = tools
  ctx.setThreadPanelState((prev) => {
    const authorized = !!prev.collabTask?.executionAuthorized
    const phaseLc = String(prev.collabPhase || '')
      .trim()
      .toLowerCase()
    const executing = phaseLc === 'executing' || phaseLc === 'awaiting_exec'
    let nextPhase = prev.collabPhase
    if (hit?.boundPlanReady && !authorized && !executing) {
      nextPhase = 'plan_ready'
    } else if (!hit?.boundPlanReady && phaseLc !== 'plan_ready' && phaseLc !== 'executing') {
      nextPhase = 'planning'
    }
    return {
      ...prev,
      planInputFallback: hit?.planInput || prev.planInputFallback || null,
      collabPhase: nextPhase,
      clarification: hit?.boundPlanReady ? null : prev.clarification,
      ...(hit?.boundPlanReady && !authorized && !executing
        ? {
            collabTask: {
              ...(prev.collabTask || { taskId: String(hit.taskId || '').trim() || 'plan-pending' }),
              ...(hit.taskId ? { taskId: hit.taskId } : {}),
              status: 'planned',
              boundPlanReady: true,
              executionAuthorized: prev.collabTask?.executionAuthorized ?? false,
            } as CollabTaskSnapshot,
          }
        : {}),
    }
  })
  return true
}
