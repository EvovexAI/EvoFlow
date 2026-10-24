// @ts-nocheck — mechanical P93 extract.
/**
 * Session switch layout: commit previous runtime, mount next. Extracted from ChatApp.tsx (P93).
 */
export type RunSessionSwitchLayoutCtx = Record<string, any>

export function runSessionSwitchLayoutEffect(ctx: RunSessionSwitchLayoutCtx): void {
  const {
    activeChatRunIdRef,
    commitActiveSessionRuntime,
    displayRowsEquivalent,
    emptyStream,
    getSessionRuntime,
    isSessionRuntimeLive,
    markResumeAnchorAssistantIncomplete,
    mountSessionRuntime,
    prevSelectedSessionCleanupRef,
    prevSwitchRevisionRef,
    reattachRetryCountRef,
    refreshAttachAttemptedRef,
    rowsRef,
    seenRunIdsRef,
    selectedSessionKey,
    sessionRef,
    sessionSwitchFromRef,
    sessionsRef,
    setRows,
    shellSelectRevision,
    ssLog,
    skTail,
    streamRef,
    streamRefKeyRef,
  } = ctx
  const prev = prevSelectedSessionCleanupRef.current
  const sk = String(selectedSessionKey || '').trim()
  const rev = shellSelectRevision
  if (prev === sk && rev === prevSwitchRevisionRef.current) return
  prevSwitchRevisionRef.current = rev
  ssLog('switch.layout', { from: skTail(prev ?? ''), to: skTail(sk), rev })
  sessionSwitchFromRef.current = prev ? prev : ''
  if (prev) {
    const prevRt = getSessionRuntime(prev)
    const activeSkNow = String(sessionRef.current || '').trim()
    const streamForCommit =
      streamRef.current === prevRt.stream || activeSkNow === prev
        ? streamRef.current
        : prevRt.stream
    commitActiveSessionRuntime(prev, {
      rows: rowsRef.current,
      stream: streamForCommit,
      seenRunIds: seenRunIdsRef.current,
      activeChatRunId: activeChatRunIdRef.current,
    })
  }
  delete refreshAttachAttemptedRef.current[sk]
  reattachRetryCountRef.current = 0
  if (sk) {
    const rt = mountSessionRuntime(sk, {
      streamRef,
      seenRunIdsRef,
      activeChatRunIdRef,
    })
    if (isSessionRuntimeLive(rt)) {
      const runId =
        String(rt.activeChatRunId || '').trim() ||
        String(sessionsRef.current.find((s) => String(s.sessionKey || '') === sk)?.currentRunId || '').trim()
      const liveRows = runId
        ? markResumeAnchorAssistantIncomplete([...rt.rows], runId)
        : [...rt.rows]
      // 等价于当前 rows 时复用 prev 引用，避免 SSE delta 期间 baseHistoryItems 反复重算。
      setRows((prevRows) => (displayRowsEquivalent(prevRows, liveRows) ? prevRows : liveRows))
      // 旧 publishLiveStreamNow 已删：resume 时由 buildStreamDisplayRow 直接读 rt.stream
    }
  } else {
    streamRef.current = emptyStream()
    streamRefKeyRef.current = ''
    seenRunIdsRef.current = new Set()
    activeChatRunIdRef.current = null
  }
  prevSelectedSessionCleanupRef.current = sk
}
