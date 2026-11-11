// @ts-nocheck — mechanical P136 extract.
/**
 * Debounced PUT / best-effort DELETE of live-run snapshots via gateway API.
 * Extracted from ChatApp.tsx (P136).
 *
 * 多会话并流行时：后台会话用更长 debounce，避免 PUT /live-run 占满 gatewayProxy
 * 槽位，把 V4 subscribe 堵到 45–110s（切会话空白开根因之一）。
 */
export type LiveRunSnapshotPersistCtx = Record<string, any>

const LIVE_RUN_PUT_SELECTED_MS = 2_000
const LIVE_RUN_PUT_BACKGROUND_MS = 10_000

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
  const selected = String(ctx.selectedSessionKeyRef?.current || '').trim()
  const isSelected = !selected || selected === sk
  const delayMs = isSelected ? LIVE_RUN_PUT_SELECTED_MS : LIVE_RUN_PUT_BACKGROUND_MS
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
  }, delayMs)
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
