/**
 * Apply a successful plan tool hit into the plan dock via API sync.
 * Extracted from ChatApp.tsx (P47).
 */
export type ApplyPlanToolSuccessHit = {
  taskId?: string
  preview?: string
  status?: string
  planInput?: Record<string, unknown>
  planOutput?: Record<string, unknown>
  boundPlanReady?: boolean
}

export type ApplyPlanToolSuccessCtx = {
  syncPlanPanelFromApi: (opts: {
    source: string
    hintTaskId?: string
    preview?: string
    fallback?: Record<string, unknown> | null
    planOutput?: Record<string, unknown> | null
    boundPlanReady?: boolean
    openSidebar?: boolean
  }) => Promise<void>
}

export async function applyPlanToolSuccess(
  ctx: ApplyPlanToolSuccessCtx,
  hit: ApplyPlanToolSuccessHit,
): Promise<void> {
  await ctx.syncPlanPanelFromApi({
    source: 'tool_success',
    hintTaskId: hit.taskId,
    preview: hit.preview,
    fallback: hit.planInput || null,
    planOutput: hit.planOutput ?? null,
    boundPlanReady: hit.boundPlanReady,
    openSidebar: true,
  })
}
