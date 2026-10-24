// @ts-nocheck — mechanical P95 extract.
/**
 * F5 page-load: resume or stale-stop running session. Extracted from ChatApp.tsx (P95).
 */
export type RunPageLoadResumeCtx = Record<string, any>

export function runPageLoadResumeEffect(ctx: RunPageLoadResumeCtx): void {
  const {
    listLoading,
    pageLoadResumeDoneRef,
    requestManualStreamResumeRef,
    selectedSessionKey,
    sessions,
    stopSessionExecutionRef,
    toast,
  } = ctx
  if (listLoading || pageLoadResumeDoneRef.current) return
  const sk = String(selectedSessionKey || '').trim()
  if (!sk) return
  const row = sessions.find((s) => String(s.sessionKey || '') === sk)
  const st = String(row?.runStatus || '').trim().toLowerCase()
  if (st !== 'running' && st !== 'pending') {
    pageLoadResumeDoneRef.current = true
    return
  }
  pageLoadResumeDoneRef.current = true
  // Check if the run is stale (no activity for > 10 minutes) before resuming.
  // If stale, cancel instead of resuming — matches backend P0 stale-run threshold.
  // Falls back to updatedAt (epoch-ms) when currentTurnStartedAt is absent.
  const _STALE_RUN_THRESHOLD_MS = 10 * 60 * 1000
  const _startedAt = row?.currentTurnStartedAt
  const _startedMs = _startedAt ? new Date(_startedAt).getTime() : 0
  const _updatedMs = typeof row?.updatedAt === 'number' ? row.updatedAt : 0
  const _refMs = _updatedMs || _startedMs
  if (_refMs && Date.now() - _refMs > _STALE_RUN_THRESHOLD_MS) {
    toast('上次会话已超时，正在自动停止…', 'info')
    void stopSessionExecutionRef.current?.(sk, { showToast: false })
    return
  }
  requestManualStreamResumeRef.current(sk, { refreshSessions: false })
}
