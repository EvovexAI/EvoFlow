// @ts-nocheck — mechanical P97 extract.
/**
 * Manual stream resume (user refresh / page-load). Extracted from ChatApp.tsx (P97).
 */
import { ohwLog, ohwWarn } from '../../lib/observer-history-watch-debug.js'

export type RequestManualStreamResumeCtx = Record<string, any>

export function requestManualStreamResume(
  ctx: RequestManualStreamResumeCtx,
  sessionKey: string,
  opts?: { refreshSessions?: boolean; observerCatchup?: boolean },
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
  const observerCatchup = !!opts?.observerCatchup
  // Never abortStreamWire a live POST /runs/stream — that is the send itself.
  // Observer / F5: allow when busy but we don't own the wire (Feishu-triggered runs).
  if (
    shouldSuppressAutoReattach({
      sessionKey: sk,
      runtime: rt,
      manualForce: !observerCatchup,
      observerCatchup,
    })
  ) {
    srLog('stream resume skipped — live POST stream', { sessionKey: sk, observerCatchup })
    ohwWarn('requestManualStreamResume suppressed', {
      sessionKey: sk,
      observerCatchup,
      streamWireSource: rt.streamWireSource ?? null,
      turnPhase: rt.turnPhase,
      uiTurnSettled: rt.uiTurnSettled,
    })
    return
  }
  delete refreshAttachAttemptedRef.current[sk]
  reattachRetryCountRef.current = 0
  srLog(observerCatchup ? 'observer history-watch requested' : 'stream resume requested (user refresh)', {
    sessionKey: sk,
  })
  ohwLog('requestManualStreamResume → bump reattach', {
    sessionKey: sk,
    observerCatchup,
    streamWireSource: rt.streamWireSource ?? null,
    turnPhase: rt.turnPhase,
    activeChatRunId: rt.activeChatRunId ?? null,
  })
  manualReattachSessionKeyRef.current = sk
  const row = sessionsRef.current.find((s) => String(s.sessionKey || '') === sk)
  const runId = String(rt.activeChatRunId || row?.currentRunId || '').trim()
  // Only tear down a wire this client actually owns.
  if (runId && rt.streamWireSource === 'run') wsClient.abortStreamWire(sk, runId)
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
