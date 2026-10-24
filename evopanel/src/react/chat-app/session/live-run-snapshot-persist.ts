// @ts-nocheck — mechanical P136 extract.
/**
 * Debounced PUT / best-effort DELETE of live-run snapshots via gateway API.
 * Extracted from ChatApp.tsx (P136).
 */
export type LiveRunSnapshotPersistCtx = Record<string, any>

export function putLiveRunSnapshotBestEffort(
  ctx: LiveRunSnapshotPersistCtx,
  sessionKey: string,
  snapshot: {
    runId: string
    threadId: string | null
    status: string
    partialText: string
    partialTools: unknown[]
    partialDisplaySegments?: unknown[]
    lastEventAtMs: number
  },
): void {
  const sk = String(sessionKey || '').trim()
  const runId = String(snapshot.runId || '').trim()
  if (!sk || !runId) return
  ctx.liveRunPersistPendingRef.current[sk] = snapshot
  const prevTimer = ctx.liveRunPersistTimerRef.current[sk]
  if (prevTimer) clearTimeout(prevTimer)
  ctx.liveRunPersistTimerRef.current[sk] = setTimeout(() => {
    const latest = ctx.liveRunPersistPendingRef.current[sk]
    ctx.liveRunPersistTimerRef.current[sk] = null
    if (!latest) return
    void ctx
      .gatewayApiFetch(`/chat/sessions/${encodeURIComponent(sk)}/live-run`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(latest),
      })
      .catch(() => {})
  }, 2000)
}

export function deleteLiveRunSnapshotBestEffort(
  ctx: LiveRunSnapshotPersistCtx,
  sessionKey: string,
): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  const prevTimer = ctx.liveRunPersistTimerRef.current[sk]
  if (prevTimer) clearTimeout(prevTimer)
  ctx.liveRunPersistTimerRef.current[sk] = null
  ctx.liveRunPersistPendingRef.current[sk] = null
  void ctx
    .gatewayApiFetch(`/chat/sessions/${encodeURIComponent(sk)}/live-run`, { method: 'DELETE' })
    .catch(() => {})
}
