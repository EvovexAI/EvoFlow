/**
 * Layer 1 — Read model
 */

import {
  getSessionRuntime,
  isSessionRuntimeLive,
  isTurnBusy,
  rtIsStoppedRun,
} from '../session-runtime-store.js'
import { isSessionRecoveryCooldownActive } from '../stream-reattach-cooldown.js'
import { getSessionExecutionProbe } from './probe-cache.js'
import { isSessionGoalRunning } from './goal-mode-state.js'
import type { SessionExecutionRow } from './types.js'

const ACTIVE_DB_RUN_STATUSES = new Set(['running', 'pending'])

export function isBackendRunActive(status: string | null | undefined): boolean {
  return ACTIVE_DB_RUN_STATUSES.has(String(status || '').trim().toLowerCase())
}

export function isSessionTurnPhaseBusy(sessionKey: string | null | undefined): boolean {
  const sk = String(sessionKey || '').trim()
  if (!sk) return false
  return isTurnBusy(getSessionRuntime(sk))
}

export function isSessionWireActive(sessionKey: string | null | undefined): boolean {
  const sk = String(sessionKey || '').trim()
  if (!sk) return false
  const rt = getSessionRuntime(sk)
  return isTurnBusy(rt) || isSessionRuntimeLive(rt)
}

export function isSessionExecuting(
  sessionKey: string | null | undefined,
  opts: { sessionRow?: SessionExecutionRow | null } = {},
): boolean {
  const sk = String(sessionKey || '').trim()
  if (!sk) return false
  const rt = getSessionRuntime(sk)
  if (isTurnBusy(rt)) return true
  if (isSessionRuntimeLive(rt)) return true

  // 用户停止后的 recovery 冷却：忽略 DB/probe 残留的 running（LangGraph 取消有延迟）
  if (isSessionRecoveryCooldownActive(sk)) return false

  const row = opts.sessionRow
  const st = String(row?.runStatus || '').trim().toLowerCase()
  // 本地已盖章结束（currentTurnEndedAt）且 turn idle：忽略 refresh 带回的 stale running
  if (
    (rt.turnPhase === 'idle' || rt.turnPhase === 'degraded') &&
    row?.currentTurnEndedAt &&
    isBackendRunActive(st)
  ) {
    return false
  }
  const probe = getSessionExecutionProbe(sk)
  if (probe?.executing === true) {
    const probeRunId = String(row?.currentRunId || rt.activeChatRunId || '').trim()
    if (!probeRunId || !rtIsStoppedRun(rt, probeRunId)) return true
  }
  if (isSessionGoalActive(sk)) return true
  if (!isBackendRunActive(st)) return false
  if (rt.turnPhase !== 'idle' && rt.turnPhase !== 'degraded') return false
  const runId = String(row?.currentRunId || rt.activeChatRunId || '').trim()
  return !rtIsStoppedRun(rt, runId)
}

/** @deprecated 使用 isSessionExecuting */
export const isSessionSidebarExecuting = isSessionExecuting

/** 目标模式是否在跑（本地标记 + 后端 probe goalActive/hostedActive） */
export function isSessionGoalActive(sessionKey: string | null | undefined): boolean {
  const sk = String(sessionKey || '').trim()
  if (!sk) return false
  const probe = getSessionExecutionProbe(sk)
  return isSessionGoalRunning(sk) || probe?.goalActive === true
}

export function collectExecutingSessionKeys<T extends SessionExecutionRow>(
  sessions: T[],
): Set<string> {
  const set = new Set<string>()
  for (const s of sessions) {
    const sk = String(s.sessionKey || '').trim()
    if (!sk) continue
    if (isSessionExecuting(sk, { sessionRow: s })) set.add(sk)
  }
  return set
}
