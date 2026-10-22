// @ts-nocheck — mechanical P84 extract.
/**
 * Collab unified WS subscription effect callback. Extracted from ChatApp.tsx (P84).
 */
export type InstallCollabUnifiedWsCtx = Record<string, any>

export function runCollabUnifiedWsEffect(ctx: InstallCollabUnifiedWsCtx): void | (() => void) {
  const {
    applyTaskProgressSnapshot,
    boundTaskId,
    collabOn,
    dispatchCollabCustomEvent,
    ensureSubtasksVisibleForTask,
    executingSessionKeysRef,
    isPendingSubtaskKey,
    isSessionGoalActive,
    selectedSessionKey,
    sessionTasksFetchSeqRef,
    setThreadPanelState,
    subscribeCollabThreadWs,
    threadPanelState,
    turnBusyForSession,
    wsClient,
    isActiveSessionFetch,
  } = ctx
  const key = selectedSessionKey
  if (!key) return
  const threadId = wsClient.getSessionThreadId(key)
  if (!threadId) return

  const taskId = String(
    threadPanelState.collabTask?.taskId || boundTaskId || threadPanelState.boundTaskId || '',
  ).trim()
  const phase = String(threadPanelState.collabPhase || '').trim().toLowerCase()
  const subs = threadPanelState.collabSubtasks || []
  const needsBackfill =
    !!taskId &&
    (turnBusyForSession(key) || executingSessionKeysRef.current.has(key)) &&
    subs.some((s) => isPendingSubtaskKey(s.subtaskId))
  const needsPhaseSync =
    collabOn &&
    (turnBusyForSession(key) || executingSessionKeysRef.current.has(key) || isSessionGoalActive(key)) &&
    (phase === 'executing' || phase === 'verifying' || phase === 'reflecting')

  const isTaskActive = () => {
    if (!turnBusyForSession(key) && !executingSessionKeysRef.current.has(key) && !isSessionGoalActive(key)) {
      return false
    }
    const mainStatus = String(threadPanelState.collabTask?.status || '').trim().toLowerCase()
    const terminalMainStatus = new Set(['completed', 'failed', 'cancelled'])
    const activeMainStatus = new Set(['executing', 'in_progress', 'running', 'waiting_dispatch', 'waiting_user'])
    const phaseActive = phase !== '' && phase !== 'idle' && phase !== 'done'
    const statusTerminal = !!mainStatus && terminalMainStatus.has(mainStatus)
    const statusActive = (!!mainStatus && !statusTerminal) || activeMainStatus.has(mainStatus)
    return statusTerminal
      ? phase === 'verifying'
      : phaseActive || statusActive || (phase as string) === 'verifying'
  }
  const needsSidebar = isTaskActive()
  const subRunning = subs.some((s) => {
    const st = String(s.status || '')
      .trim()
      .toLowerCase()
    return st === 'in_progress' || st === 'running' || st === 'executing' || st === 'active'
  })
  const needsNodeStream =
    collabOn &&
    (!!taskId || subRunning) &&
    (turnBusyForSession(key) ||
      executingSessionKeysRef.current.has(key) ||
      isSessionGoalActive(key) ||
      subRunning ||
      phase === 'executing' ||
      phase === 'verifying')

  if (!needsBackfill && !needsPhaseSync && !needsSidebar && !needsNodeStream) return

  const fetchSeq = sessionTasksFetchSeqRef.current
  let pollLogMod: typeof import('../../../lib/poll-loop-log.js') | null = null
  void import('../../../lib/poll-loop-log.js').then((mod) => {
    pollLogMod = mod
    mod.logPollLoopStart('collab_unified_ws', {
      sessionKey: key,
      threadId,
      phase,
      needsPhaseSync,
      needsSidebar,
      needsBackfill,
      needsNodeStream,
    })
  })

  const pushSubagentStreamPayload = (payload: Record<string, unknown>) => {
    const inner = String(payload?.type || '').trim()
    if (!inner.startsWith('task_') && inner !== 'subagent_token_delta') return
    dispatchCollabCustomEvent(key, payload)
  }

  const handleWsEvent = (ev: { type?: string; data?: Record<string, unknown> }) => {
    if (!isActiveSessionFetch(key, fetchSeq)) return
    const type = String(ev?.type || '').trim()
    const data = ev?.data && typeof ev.data === 'object' ? ev.data : {}
    pollLogMod?.logPollTick('collab_unified_ws', key, 30000, { phase, eventType: type })

    if (type === 'collab:snapshot') {
      applyTaskProgressSnapshot(data as Record<string, unknown>, { sessionKey: key })
      return
    }
    if (type === 'collab:state') {
      const serverPhase = String(data.collab_phase || '').trim().toLowerCase()
      const bound = String(data.bound_task_id || '').trim()
      if (serverPhase || bound) {
        setThreadPanelState((prev) => ({
          ...prev,
          ...(serverPhase ? { collabPhase: serverPhase } : {}),
          ...(bound ? { boundTaskId: bound } : {}),
        }))
        if (serverPhase) {
          void import('../../../lib/tauri-api.js').then(({ api: chatApi }) => {
            void chatApi.chatUpdateContext(key, { collab_phase: serverPhase })
          })
        }
      }
      return
    }
    // Workflow node live output (task_running with LangChain message chunks)
    if (type === 'node:output') {
      pushSubagentStreamPayload(data as Record<string, unknown>)
      return
    }
    if (type === 'task:progress') {
      const sid = String(data.collab_subtask_id || data.collabSubtaskId || data.task_id || '').trim()
      if (sid) {
        dispatchCollabCustomEvent(key, {
          type: 'task_running',
          collab_subtask_id: sid,
          task_id: sid,
          progress: data.progress,
          status: data.status,
          current_step: data.current_step || data.currentStep,
        })
      }
      return
    }
    if (type.startsWith('task:')) {
      const innerType = String(data.type || '').trim()
      if (innerType.startsWith('task_') || innerType === 'subagent_token_delta') {
        pushSubagentStreamPayload(data as Record<string, unknown>)
      }
      return
    }
    if (type === 'agent:custom' || type === 'agent:evf') {
      pushSubagentStreamPayload(data as Record<string, unknown>)
    }
  }

  const unsub = subscribeCollabThreadWs(threadId, {
    mainTaskId: taskId || undefined,
    onEvent: handleWsEvent,
    onOpen: () => {
      if (needsBackfill && taskId) void ensureSubtasksVisibleForTask(taskId)
    },
  })

  return () => {
    pollLogMod?.logPollLoopEnd('collab_unified_ws', { sessionKey: key })
    unsub()
  }
}
