/**
 * Diagnose stop-button / spinner flicker: log why ``isSessionExecuting`` flips.
 * Always on in browser console with prefix ``[BusyReason]`` so Network SSE + this
 * line can be compared without an env flag.
 */

import {
  getSessionRuntime,
  isSessionRuntimeLive,
  isTurnBusy,
} from './session-runtime-store.js'
import { streamRefHasVisibleContent } from './stream-state.js'
import { getSessionExecutionProbe } from './session-execution/probe-cache.js'
import { isSessionGoalRunning } from './session-execution/goal-mode-state.js'
import type { SessionExecutionRow } from './session-execution/types.js'

const ACTIVE_DB = new Set(['running', 'pending'])

export type BusyReasonSnapshot = {
  executing: boolean
  reasons: string[]
  turnPhase: string
  uiTurnSettled: boolean
  turnPhaseBusy: boolean
  streamLive: boolean
  streamVisible: boolean
  probeExecuting: boolean
  goalActive: boolean
  dbRunStatus: string
}

const lastBySession = new Map<string, string>()

export function snapshotBusyReasons(
  sessionKey: string | null | undefined,
  opts: { sessionRow?: SessionExecutionRow | null; executing: boolean } = { executing: false },
): BusyReasonSnapshot {
  const sk = String(sessionKey || '').trim()
  const rt = getSessionRuntime(sk)
  const row = opts.sessionRow
  const st = String(row?.runStatus || '').trim().toLowerCase()
  const probe = getSessionExecutionProbe(sk)
  const reasons: string[] = []
  if (isTurnBusy(rt)) reasons.push(`turnPhase=${rt.turnPhase}`)
  if (rt.uiTurnSettled) reasons.push('uiTurnSettled')
  else {
    if (isSessionRuntimeLive(rt) && !isTurnBusy(rt)) reasons.push('streamVisible(whileIdle)')
    if (probe?.executing) reasons.push('probe.executing')
    if (isSessionGoalRunning(sk) || probe?.goalActive) reasons.push('goalActive')
    if (ACTIVE_DB.has(st)) reasons.push(`dbRunStatus=${st}`)
  }
  if (opts.executing && reasons.length === 0) reasons.push('executing(unknown)')
  if (!opts.executing) reasons.push('idle')
  return {
    executing: !!opts.executing,
    reasons,
    turnPhase: String(rt.turnPhase || 'idle'),
    uiTurnSettled: !!rt.uiTurnSettled,
    turnPhaseBusy: isTurnBusy(rt),
    streamLive: isSessionRuntimeLive(rt),
    streamVisible: streamRefHasVisibleContent(rt.stream),
    probeExecuting: probe?.executing === true,
    goalActive: isSessionGoalRunning(sk) || probe?.goalActive === true,
    dbRunStatus: st || '(none)',
  }
}

/** Log only when the reason signature changes (avoid spam). */
export function logBusyReasonIfChanged(
  sessionKey: string | null | undefined,
  opts: { sessionRow?: SessionExecutionRow | null; executing: boolean; source?: string },
): void {
  const sk = String(sessionKey || '').trim()
  if (!sk || typeof console === 'undefined') return
  const snap = snapshotBusyReasons(sk, opts)
  const sig = `${snap.executing}|${snap.reasons.join(',')}|${snap.turnPhase}|${snap.uiTurnSettled}`
  if (lastBySession.get(sk) === sig) return
  lastBySession.set(sk, sig)
  const tag = snap.executing ? 'BUSY' : 'IDLE'
  console.warn(
    `[BusyReason] ${tag} sk=${sk.slice(0, 48)} source=${opts.source || '?'} reasons=[${snap.reasons.join(' | ')}]`,
    snap,
  )
}
