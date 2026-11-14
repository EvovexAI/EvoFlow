/**
 * Layer 1 — Read model
 */

import {
  getSessionRuntime,
  isLivePostStreamOpen,
  isSessionRuntimeLive,
  isTurnBusy,
  rtIsStoppedRun,
} from '../session-runtime-store.js'
import { isSessionRecoveryCooldownActive } from '../stream-reattach-cooldown.js'
import { getV4TimelineBusy } from '../../v4/v4-timeline-busy-store.js'
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
  // live POST open counts even if turnPhase was incorrectly idled mid-loop
  return isTurnBusy(rt) || isSessionRuntimeLive(rt) || isLivePostStreamOpen(rt)
}

export function isSessionExecuting(
  sessionKey: string | null | undefined,
  opts: { sessionRow?: SessionExecutionRow | null } = {},
): boolean {
  const sk = String(sessionKey || '').trim()
  if (!sk) return false
  const rt = getSessionRuntime(sk)
  if (isTurnBusy(rt)) return true

  // Local turn already settled (early RUN_FINISHED / abort). Stream buffer may
  // still hold visible text until SSE `final`, and DB/probe may stay `running`
  // through checkpoint — neither must revive the stop button.
  if (rt.uiTurnSettled) {
    return isSessionGoalActive(sk)
  }

  // 用户停止后的 recovery 冷却：必须先于 stream 残留 / live POST / V4 busy。
  // 否则右下角已按冷却熄灭，左侧仍被 isSessionRuntimeLive（缓冲里还有字）钉转。
  if (isSessionRecoveryCooldownActive(sk)) return false

  // Browser-owned POST /runs/stream still open: keep stop / list spinner /
  // 「绘画」preview even if a mid-turn RUN_FINISHED left turnPhase idle.
  if (isLivePostStreamOpen(rt)) return true

  if (isSessionRuntimeLive(rt)) return true

  // V4 时间线仍有 streaming / running 工具（含后台 pin）：侧栏齿轮与 pin 集合同源。
  if (getV4TimelineBusy(sk)) return true

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
