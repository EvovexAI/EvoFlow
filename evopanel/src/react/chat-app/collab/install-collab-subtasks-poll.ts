// @ts-nocheck — mechanical P99 extract.
/**
 * While collab exec is active, bump subtasks API refresh. Extracted (P99).
 */
export type InstallCollabSubtasksPollCtx = Record<string, any>

export function runCollabSubtasksPollEffect(
  ctx: InstallCollabSubtasksPollCtx,
): void | (() => void) {
  const {
    bumpSubtasksApiRefresh,
    collabSubtasksFetchEnabled,
    isActiveExecTaskStatus,
    selectedTurnBusy,
    sharedCollabMainTaskStatus,
    threadPanelState,
  } = ctx
  if (!collabSubtasksFetchEnabled) return
  const phaseLc = String(threadPanelState.collabPhase || '').trim().toLowerCase()
  const isRunning =
    isActiveExecTaskStatus(sharedCollabMainTaskStatus) ||
    phaseLc === 'executing' ||
    phaseLc === 'verifying' ||
    phaseLc === 'reflecting' ||
    selectedTurnBusy
  if (!isRunning) return
  const tick = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    bumpSubtasksApiRefresh()
  }
  const interval = window.setInterval(tick, 3000)
  return () => window.clearInterval(interval)
}
