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
    // streamForCommit：提交给旧会话的流快照。
    // ⚠️ 注意：此时 sessionRef.current 可能已经指向新会话（sessionRef 同步已提前到切换 effect 之前），
    // 所以不能再用 `sessionRef.current === prev` 判定「当前流属于旧会话」。
    // 可靠依据是对象身份：streamRef.current 若仍挂在旧会话的 runtime 上，就用当前引用，
    // 否则用旧 runtime 自带的 stream（避免把新会话的流写进旧会话）。
    const streamForCommit =
      streamRef.current === prevRt.stream ? streamRef.current : prevRt.stream
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
