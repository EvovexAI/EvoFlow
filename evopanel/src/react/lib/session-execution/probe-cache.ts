/**
 * 后端 GET execution/state — 只读 evoflow_chat_sessions.run_status。
 */

import { fetchSessionExecutionState, type RuntimeStatusResponse } from '../session-reattach.js'
import { isSessionGoalRunning, markSessionGoalRunning } from './goal-mode-state.js'
import type { SessionExecutionRow } from './types.js'

const ACTIVE_DB_RUN_STATUSES = new Set(['running', 'pending'])

export type SessionExecutionProbe = {
  executing: boolean
  goalActive: boolean
  runStatus: string | null
  fetchedAt: number
}

let epoch = 0
const cache = new Map<string, SessionExecutionProbe>()
const listeners = new Set<() => void>()
let refreshInflight: Promise<void> | null = null

function bump(): void {
  epoch += 1
  for (const fn of listeners) {
    try {
      fn()
    } catch {
      /* ignore */
    }
  }
}

export function getSessionExecutionProbeEpoch(): number {
  return epoch
}

export function subscribeSessionExecutionProbes(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getSessionExecutionProbe(sessionKey: string | null | undefined): SessionExecutionProbe | null {
  const sk = String(sessionKey || '').trim()
  if (!sk) return null
  return cache.get(sk) ?? null
}

export function setSessionExecutionProbe(
  sessionKey: string,
  data: Pick<SessionExecutionProbe, 'executing' | 'goalActive' | 'runStatus'>,
): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  const prev = cache.get(sk)
  const next: SessionExecutionProbe = {
    executing: !!data.executing,
    goalActive: data.goalActive === true,
    runStatus: data.runStatus ?? null,
    fetchedAt: Date.now(),
  }
  if (
    prev &&
    prev.executing === next.executing &&
    prev.goalActive === next.goalActive &&
    prev.runStatus === next.runStatus
  ) {
    return
  }
  cache.set(sk, next)
  if (next.goalActive) markSessionGoalRunning(sk, true)
  bump()
}

export function clearSessionExecutionProbe(sessionKey: string): void {
  const sk = String(sessionKey || '').trim()
  if (!sk || !cache.has(sk)) return
  cache.delete(sk)
  bump()
}

function probeFromResponse(st: RuntimeStatusResponse | null): SessionExecutionProbe | null {
  if (!st) return null
  const goalActive = st.goalActive === true || st.hostedActive === true
  return {
    executing: st.executing === true,
    goalActive,
    runStatus: String(st.runStatus || st.phase || 'done').trim().toLowerCase() || 'done',
    fetchedAt: Date.now(),
  }
}

export async function fetchAndCacheSessionExecutionState(
  sessionKey: string,
): Promise<SessionExecutionProbe | null> {
  const sk = String(sessionKey || '').trim()
  if (!sk) return null
  const st = await fetchSessionExecutionState(sk, { bypassCache: true })
  const probe = probeFromResponse(st)
  if (probe) setSessionExecutionProbe(sk, probe)
  return probe
}

function pickProbeCandidates<T extends SessionExecutionRow>(
  sessions: T[],
  opts: { foregroundKey?: string | null } = {},
): string[] {
  const foreground = String(opts.foregroundKey || '').trim()
  const keys: string[] = []
  for (const s of sessions) {
    const sk = String(s.sessionKey || '').trim()
    if (!sk || sk === foreground) continue
    const st = String(s.runStatus || '').trim().toLowerCase()
    const cached = cache.get(sk)
    if (
      ACTIVE_DB_RUN_STATUSES.has(st) ||
      cached?.executing ||
      cached?.goalActive ||
      isSessionGoalRunning(sk)
    ) {
      keys.push(sk)
    }
  }
  return keys.slice(0, 12)
}

export async function refreshBackgroundExecutionProbes<T extends SessionExecutionRow>(
  sessions: T[],
  opts: { foregroundKey?: string | null } = {},
): Promise<void> {
  if (refreshInflight) {
    await refreshInflight
    return
  }
  const keys = pickProbeCandidates(sessions, opts)
  if (!keys.length) return

  refreshInflight = (async () => {
    await Promise.all(
      keys.map(async (sk) => {
        try {
          await fetchAndCacheSessionExecutionState(sk)
        } catch {
          /* best effort */
        }
      }),
    )
  })().finally(() => {
    refreshInflight = null
  })
  await refreshInflight
}
