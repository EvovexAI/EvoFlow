// @ts-nocheck — mechanical P97 extract.
/**
 * Manual stream resume (user refresh / page-load). Extracted from ChatApp.tsx (P97).
 */
export type RequestManualStreamResumeCtx = Record<string, any>

export function requestManualStreamResume(
  ctx: RequestManualStreamResumeCtx,
  sessionKey: string,
  opts?: { refreshSessions?: boolean },
): void {
  const {
    bumpReattachRetryRef,
    getSessionRuntime,
    manualReattachSessionKeyRef,
    reattachRetryCountRef,
    refreshAttachAttemptedRef,
    refreshSessionsRef,
    sessionRef,
    sessionsRef,
    setNewChatButtonActive,
    setSelectedSessionKey,
    shouldSuppressAutoReattach,
    srLog,
    wsClient,
  } = ctx
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  const rt = getSessionRuntime(sk)
  // Never abortStreamWire a live POST /runs/stream — that is the send itself.
  if (shouldSuppressAutoReattach({ sessionKey: sk, runtime: rt })) {
    srLog('stream resume skipped — live POST stream', { sessionKey: sk })
    return
  }
  delete refreshAttachAttemptedRef.current[sk]
  reattachRetryCountRef.current = 0
  srLog('stream resume requested (user refresh)', { sessionKey: sk })
  manualReattachSessionKeyRef.current = sk
  const row = sessionsRef.current.find((s) => String(s.sessionKey || '') === sk)
  const runId = String(rt.activeChatRunId || row?.currentRunId || '').trim()
  if (runId) wsClient.abortStreamWire(sk, runId)
  if (sessionRef.current !== sk) {
    sessionRef.current = sk
    setSelectedSessionKey(sk)
    setNewChatButtonActive(false)
  }
  if (opts?.refreshSessions !== false) {
    void refreshSessionsRef.current?.({ skipAutoReselect: true })
  }
  bumpReattachRetryRef.current?.()
}
