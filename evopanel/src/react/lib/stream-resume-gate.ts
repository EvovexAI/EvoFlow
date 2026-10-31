/**
 * Pure gate helpers for auto stream resume / reattach.
 * Local ``turnPhase`` is primary; DB ``run_status`` is cold-start bootstrap only.
 */
import type { ChatSessionRow } from '../chat-types.js'
import { isActiveRunStatus, isSessionHistoryWatchActive } from './session-reattach.js'
import {
  isSessionRecoveryCooldownActive,
  isStreamReattachCooldownActive,
} from './stream-reattach-cooldown.js'
import {
  deriveAttachState,
  getSessionRuntime,
  isSessionRuntimeLive,
  isTurnBusy,
  type SessionRuntime,
} from './session-runtime-store.js'

/** Skip auto reattach while a live POST ``/runs/stream`` or busy turn is active. */
export function shouldSuppressAutoReattach(opts: {
  sessionKey: string
  manualForce?: boolean
  /**
   * Feishu / IM / other-channel observer: session is running on the server but
   * this client never opened POST /runs/stream. Allow history-watch even when
   * local turnPhase looks busy (mirrored status), as long as we don't own the wire.
   */
  observerCatchup?: boolean
  runtime?: SessionRuntime | null
  runId?: string | null
}): boolean {
  const key = String(opts.sessionKey || '').trim()
  if (!key) return false
  const rt = opts.runtime ?? getSessionRuntime(key)
  // Live chatSend POST must never be aborted by reattach — including "manual"
  // paths used by visibility/online recovery (those still call manualForce).
  // Killing this wire mid-send shows up as client-abort and freezes the turn.
  if (rt.streamWireSource === 'run') return true
  // Early AG-UI RUN_FINISHED already settled the UI; DB may stay ``running``
  // through checkpoint. Reattach would clear uiTurnSettled and bounce the list.
  if (rt.uiTurnSettled && !opts.manualForce && !opts.observerCatchup) return true
  if (opts.manualForce || opts.observerCatchup) {
    if (!opts.manualForce && isSessionRecoveryCooldownActive(key)) return true
    const runId = String(opts.runId || rt.activeChatRunId || '').trim()
    if (isStreamReattachCooldownActive(key, runId || null)) return true
    return false
  }
  if (isSessionRecoveryCooldownActive(key)) return true
  if (isTurnBusy(rt)) return true
  if (isSessionRuntimeLive(rt)) return true
  const runId = String(opts.runId || rt.activeChatRunId || '').trim()
  if (rt.turnPhase === 'degraded' && isStreamReattachCooldownActive(key, runId || null)) {
    return true
  }
  if (isStreamReattachCooldownActive(key, runId || null)) return true
  return false
}

export type ObserverHistoryWatchDecision = {
  start: boolean
  reason: string
  sessionKey: string
  streamWireSource: string | null
  turnPhase: string
  uiTurnSettled: boolean
  historyWatchActive: boolean
  runStatus: string
  inExecutingSet: boolean
  turnBusy: boolean
  runtimeLive: boolean
}

/**
 * Panel is watching a run it did not start (Feishu / IM / employee duty, etc.):
 * no local POST stream → should history-poll until idle.
 *
 * Also treats local turnBusy / runtimeLive as "running" — stop button can light
 * from mirrored AG-UI while sessions.runStatus / executing set still lag.
 */
export function decideObserverHistoryWatch(opts: {
  sessionKey: string
  runStatus?: string | null
  executingSessionKeys?: Set<string>
  runtime?: SessionRuntime | null
}): ObserverHistoryWatchDecision {
  const key = String(opts.sessionKey || '').trim()
  const rt = opts.runtime ?? (key ? getSessionRuntime(key) : null)
  const runStatus = String(opts.runStatus || '').trim().toLowerCase()
  const inExecutingSet = Boolean(key && opts.executingSessionKeys?.has(key))
  const turnBusy = isTurnBusy(rt)
  const runtimeLive = isSessionRuntimeLive(rt)
  const streamWireSource = rt?.streamWireSource ? String(rt.streamWireSource) : null
  const turnPhase = String(rt?.turnPhase || 'idle')
  const uiTurnSettled = Boolean(rt?.uiTurnSettled)
  const historyWatchActive = key ? isSessionHistoryWatchActive(key) : false
  const base = {
    sessionKey: key,
    streamWireSource,
    turnPhase,
    uiTurnSettled,
    historyWatchActive,
    runStatus: runStatus || '(empty)',
    inExecutingSet,
    turnBusy,
    runtimeLive,
  }
  if (!key) return { ...base, start: false, reason: 'no-session-key' }
  if (streamWireSource === 'run') {
    return { ...base, start: false, reason: 'owns-live-post-stream' }
  }
  if (uiTurnSettled) return { ...base, start: false, reason: 'ui-turn-settled' }
  if (historyWatchActive) return { ...base, start: false, reason: 'history-watch-already-active' }
  if (
    sessionLooksRunning({
      sessionKey: key,
      runStatus: opts.runStatus,
      executingSessionKeys: opts.executingSessionKeys,
    })
  ) {
    return { ...base, start: true, reason: 'db-or-executing-set-running' }
  }
  // Stop button / busy chrome can light from mirrored turn without DB row yet.
  if (turnBusy || runtimeLive) {
    return { ...base, start: true, reason: 'local-turn-busy-without-live-post' }
  }
  return { ...base, start: false, reason: 'not-running' }
}

export function shouldStartObserverHistoryWatch(opts: {
  sessionKey: string
  runStatus?: string | null
  executingSessionKeys?: Set<string>
  runtime?: SessionRuntime | null
}): boolean {
  return decideObserverHistoryWatch(opts).start
}

export function shouldAutoStreamResume(opts: {
  selectedSessionKey: string | null | undefined
  sessionRow?: ChatSessionRow | null
  executingSessionKeys?: Set<string>
}): boolean {
  const key = String(opts.selectedSessionKey || '').trim()
  if (!key) return false
  const rt = getSessionRuntime(key)
  if (rt.uiTurnSettled) return false
  if (isTurnBusy(rt)) return false
  const rowSt = String(opts.sessionRow?.runStatus || '').trim().toLowerCase()
  if (isActiveRunStatus(rowSt)) return true
  return opts.executingSessionKeys?.has(key) ?? false
}

export function shouldSkipRefreshAttach(opts: {
  sessionKey: string
  threadId: string | null
  attemptedThreadId?: string
  looksRunning: boolean
  currentRunId?: string | null
  reattachedRunId?: string | null
}): boolean {
  const attempted = opts.attemptedThreadId
  if (!attempted || attempted !== opts.threadId) return false
  if (!opts.looksRunning) return true
  const runId = String(opts.currentRunId || '').trim()
  const reattached = String(opts.reattachedRunId || '').trim()
  if (runId && reattached && runId === reattached) return true
  return false
}

export function sessionLooksRunning(opts: {
  sessionKey: string
  runStatus?: string | null
  executingSessionKeys?: Set<string>
}): boolean {
  const st = String(opts.runStatus || '').trim().toLowerCase()
  return (
    opts.executingSessionKeys?.has(opts.sessionKey) ||
    st === 'running' ||
    st === 'pending'
  )
}

/** Manual refresh: resume stream when turn is busy, wire connected, or DB still running. */
export function shouldManualRefreshResumeStream(opts: {
  sessionKey: string
  runStatus?: string | null
  executingSessionKeys?: Set<string>
  runtime?: SessionRuntime | null
}): boolean {
  const key = String(opts.sessionKey || '').trim()
  if (!key) return false

  const rt = opts.runtime ?? getSessionRuntime(key)
  // Local early seal wins over stale DB ``running`` (checkpoint lag).
  if (rt.uiTurnSettled) return false

  if (
    sessionLooksRunning({
      sessionKey: key,
      runStatus: opts.runStatus,
      executingSessionKeys: opts.executingSessionKeys,
    })
  ) {
    return true
  }

  if (isTurnBusy(rt)) return true
  if (rt.streamWireSource === 'run' || rt.streamWireSource === 'stream-resume') return true
  if (isSessionRuntimeLive(rt)) return true
  const attach = deriveAttachState(rt)
  if (attach === 'attaching' || attach === 'attached') return true

  const liveSt = String(rt.liveRunStatus || '').trim().toLowerCase()
  if (isActiveRunStatus(liveSt)) return true

  return false
}
