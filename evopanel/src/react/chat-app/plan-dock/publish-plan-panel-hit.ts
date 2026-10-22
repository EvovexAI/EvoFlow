// @ts-nocheck — mechanical P147 extract.
/**
 * Publish plan panel hit + latch stream plan input when ready.
 * Extracted from ChatApp.tsx (P147).
 */
export type PublishPlanPanelHitCtx = Record<string, any>

export function publishPlanPanelHit(ctx: PublishPlanPanelHitCtx, hit: any): void {
  ctx.lastPlanPanelHitRef.current = hit
  ctx.setPlanPanelHit(hit)
  if (hit?.planInput || hit?.boundPlanReady) {
    ctx.planStreamLatchRef.current = {
      planInput: hit.planInput,
      boundPlanReady: hit.boundPlanReady,
      taskId: hit.taskId,
    }
    ctx.setPlanStreamLatched(true)
  }
}

export function resetPlanStreamSession(ctx: PublishPlanPanelHitCtx): void {
  ctx.lastPlanPanelHitRef.current = null
  ctx.setPlanPanelHit(null)
  ctx.planStreamLatchRef.current = null
  ctx.setPlanStreamLatched(false)
  ctx.lastPlanDetectionToolsRef.current = []
  ctx.persistedPlanInputRef.current = null
  ctx.lastPlanSyncSigRef.current = ''
}

export function applyPlanDockApiView(ctx: PublishPlanPanelHitCtx, view: any): void {
  ctx.planDockApiViewRef.current = view
  ctx.tracePlanDockApi(view.show ? 'show' : 'hide', {
    source: view.source,
    reason: view.show ? undefined : view.reason,
    taskId: view.taskId,
    taskStatus: view.show ? view.taskStatus : view.taskStatus,
    statusLabel: view.show ? view.statusLabel : undefined,
  })
  ctx.setPlanDockApiView(view)
}
