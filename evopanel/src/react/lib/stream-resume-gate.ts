/**
 * Pure gate helpers for auto stream resume / reattach.
 * Local ``turnPhase`` is primary; DB ``run_status`` is cold-start bootstrap only.
 */
import type { ChatSessionRow } from '../chat-types.js'
import { isActiveRunStatus } from './session-reattach.js'
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
  runtime?: SessionRuntime | null
  runId?: string | null
}): boolean {
  if (opts.manualForce) return false
  const key = String(opts.sessionKey || '').trim()
  if (!key) return false
  if (isSessionRecoveryCooldownActive(key)) return true
  const rt = opts.runtime ?? getSessionRuntime(key)
  if (isTurnBusy(rt)) return true
  if (rt.streamWireSource === 'run') return true
  if (isSessionRuntimeLive(rt)) return true
  const runId = String(opts.runId || rt.activeChatRunId || '').trim()
  if (rt.turnPhase === 'degraded' && isStreamReattachCooldownActive(key, runId || null)) {
    return true
  }
  if (isStreamReattachCooldownActive(key, runId || null)) return true
  return false
}

export function shouldAutoStreamResume(opts: {
  selectedSessionKey: string | null | undefined
  sessionRow?: ChatSessionRow | null
  executingSessionKeys?: Set<string>
}): boolean {
  const key = String(opts.selectedSessionKey || '').trim()
  if (!key) return false
  const rt = getSessionRuntime(key)
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

  if (
    sessionLooksRunning({
      sessionKey: key,
      runStatus: opts.runStatus,
      executingSessionKeys: opts.executingSessionKeys,
    })
  ) {
    return true
  }

  const rt = opts.runtime ?? getSessionRuntime(key)
  if (isTurnBusy(rt)) return true
  if (rt.streamWireSource === 'run' || rt.streamWireSource === 'stream-resume') return true
  if (isSessionRuntimeLive(rt)) return true
  const attach = deriveAttachState(rt)
  if (attach === 'attaching' || attach === 'attached') return true

  const liveSt = String(rt.liveRunStatus || '').trim().toLowerCase()
  if (isActiveRunStatus(liveSt)) return true

  return false
}
