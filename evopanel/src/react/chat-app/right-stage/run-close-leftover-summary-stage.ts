// @ts-nocheck — mechanical P143 extract.
/**
 * Mount: drop leftover summary right-stage tab (summary now lives in conversation chrome).
 * Extracted from ChatApp.tsx (P143).
 */
export type RunCloseLeftoverSummaryStageCtx = Record<string, any>

export function runCloseLeftoverSummaryStageEffect(
  ctx: RunCloseLeftoverSummaryStageCtx,
): void {
  ctx.closeSummaryStage()
  const remaining = ctx.filterRightStageTabsForSession(
    ctx.rightStageStore.getSnapshot().tabs,
    ctx.selectedSessionKey,
  )
  if (remaining.length === 0) ctx.collapseRightStage()
}
