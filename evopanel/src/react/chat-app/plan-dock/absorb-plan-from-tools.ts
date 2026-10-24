/**
 * Absorb plan tool input into latch + thread panel while streaming.
 * Extracted from ChatApp.tsx (P77).
 */
import type { Dispatch, SetStateAction } from 'react'
import {
  absorbPlanInputFromTools,
  analyzePlanTools,
} from '../../../lib/plan-pipeline.js'
import { pickRicherStructuredPlanInput } from '../../../lib/plan-from-task.js'
import type { PlanPanelHit, PlanStreamLatch } from './types.js'
import type { ThreadPanelState } from '../../chat-types.js'

export type AbsorbPlanFromToolsCtx = {
  persistedPlanInputRef: { current: Record<string, unknown> | null }
  planStreamLatchRef: { current: PlanStreamLatch }
  setPlanStreamLatched: (v: boolean) => void
  setThreadPanelState: Dispatch<SetStateAction<ThreadPanelState>>
  publishPlanPanelHit: (hit: PlanPanelHit | null) => void
}

export function absorbPlanFromTools(
  ctx: AbsorbPlanFromToolsCtx,
  tools: unknown[],
): void {
  const next = absorbPlanInputFromTools(ctx.persistedPlanInputRef.current, tools)
  const hit = analyzePlanTools(tools).hit
  if (!next && !hit?.boundPlanReady) return
  if (next) ctx.persistedPlanInputRef.current = next
  const prevLatch = ctx.planStreamLatchRef.current
  const mergedHit = {
    planInput: next || prevLatch?.planInput,
    boundPlanReady: !!(hit?.boundPlanReady || prevLatch?.boundPlanReady),
    taskId: hit?.taskId || prevLatch?.taskId,
    planOutput:
      (hit as Record<string, unknown> | null | undefined)?.planOutput ||
      (prevLatch as Record<string, unknown> | null | undefined)?.planOutput,
  }
  ctx.planStreamLatchRef.current = mergedHit
  ctx.setPlanStreamLatched(true)
  if (next) {
    ctx.setThreadPanelState((prev) => ({
      ...prev,
      planInputFallback: pickRicherStructuredPlanInput(next, prev.planInputFallback),
    }))
  }
  if (mergedHit.planInput || mergedHit.boundPlanReady) {
    // @ts-expect-error planOutput type mismatch
    ctx.publishPlanPanelHit(mergedHit)
  }
}
