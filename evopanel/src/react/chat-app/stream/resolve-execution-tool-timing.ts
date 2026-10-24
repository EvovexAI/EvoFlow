// @ts-nocheck — mechanical P138 extract.
/**
 * Whether the composer should show goal/collab execution timing chrome.
 * Extracted from ChatApp.tsx (P138).
 */
export type ResolveExecutionToolTimingCtx = Record<string, any>

export function resolveGoalExecutionTiming(ctx: ResolveExecutionToolTimingCtx): boolean {
  return Boolean(
    !ctx.historyLoading &&
      ctx.selectedGoalActive &&
      String(ctx.selectedSessionKey || '').trim().length > 0,
  )
}

export function resolveCollabExecutionTiming(ctx: ResolveExecutionToolTimingCtx): boolean {
  const collabPhaseLc = String(ctx.threadPanelState.collabPhase || '').trim().toLowerCase()
  return Boolean(
    ctx.liveTurnTimingActive &&
      !ctx.selectedTurnBusy &&
      (collabPhaseLc === 'executing' ||
        collabPhaseLc === 'awaiting_exec' ||
        (String(ctx.selectedSessionKey || '').trim() &&
          ctx.executingSessionKeys.has(String(ctx.selectedSessionKey || '').trim()))),
  )
}
