// @ts-nocheck — mechanical P92 extract.
/**
 * On session enter: sync plan panel from API / history tools. Extracted from ChatApp.tsx (P92).
 */
export type RunSessionEnterPlanSyncCtx = Record<string, any>

export function runSessionEnterPlanSyncEffect(
  ctx: RunSessionEnterPlanSyncCtx,
): void | (() => void) {
  const {
    boundTaskIdRef,
    collectAssistantToolArraysFromRows,
    extractLastPlanToolSuccessFromArrays,
    historyCollabHydratedRef,
    historyLoading,
    historyRowsBootstrappedRef,
    isActiveSessionFetch,
    listLoading,
    patchCollabFromStreamTools,
    planSessionEnterRef,
    resolveSessionTaskId,
    rows,
    selectedSessionKey,
    sessionBoundTaskIdRef,
    sessionRefreshInFlightRef,
    sessionTasksFetchSeqRef,
    sessionsRef,
    syncPlanPanelFromApiRef,
  } = ctx
  if (historyLoading || listLoading) return
  const sk = String(selectedSessionKey || '').trim()
  if (!sk) return
  if (sessionRefreshInFlightRef.current === sk) return

  let cancelled = false
  const fetchSeq = sessionTasksFetchSeqRef.current
  void (async () => {
    if (sessionRefreshInFlightRef.current === sk) return
    if (cancelled || !isActiveSessionFetch(sk, fetchSeq)) return
    if (planSessionEnterRef.current === sk) return
    planSessionEnterRef.current = sk
    historyCollabHydratedRef.current = sk

    const sessionRow = sessionsRef.current.find((s) => String(s.sessionKey || '') === sk)
    const sessionTaskId = resolveSessionTaskId(
      sessionRow as { collabTaskId?: string | null } | undefined,
      boundTaskIdRef.current || '',
    )
    sessionBoundTaskIdRef.current = sessionTaskId

    if (historyRowsBootstrappedRef.current !== sk) {
      historyRowsBootstrappedRef.current = sk
      if (sessionTaskId) {
        patchCollabFromStreamTools({ skipPlanPanel: true, allowAutoOpen: false })
      }
    }

    const planHit = rows.length
      ? extractLastPlanToolSuccessFromArrays(collectAssistantToolArraysFromRows(rows))
      : null
    if (cancelled || !isActiveSessionFetch(sk, fetchSeq)) return
    await syncPlanPanelFromApiRef.current({
      source: 'session_enter',
      sessionKey: sk,
      bypassCache: true,
      hintTaskId: sessionTaskId,
      fallback: (planHit as { planInput?: Record<string, unknown> } | null)?.planInput ?? null,
      planOutput: (planHit as { planOutput?: Record<string, unknown> } | null)?.planOutput ?? null,
      boundPlanReady: !!(planHit as { boundPlanReady?: boolean } | null)?.boundPlanReady,
    })
  })()

  return () => {
    cancelled = true
  }
}
