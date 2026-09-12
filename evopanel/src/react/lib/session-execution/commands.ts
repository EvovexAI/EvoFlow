/**
 * Layer 2 — Commands / state transitions
 * 运行结束、abort、会话行 patch 等写操作集中在此。
 */

import { clearActiveRun } from '../run-turn-gate.js'
import { seedSessionRuntimeStatusIdle } from '../session-reattach.js'
import {
  dispatchSessionTurnEvent,
  getSessionRuntime,
  rtAddStoppedRun,
  type SessionRuntime,
} from '../session-runtime-store.js'
import { markSessionRecoveryCooldown, markStreamReattachCooldown } from '../stream-reattach-cooldown.js'
import { clearSessionExecutionProbe } from './probe-cache.js'
import type {
  SessionRunEndedOpts,
  SessionRunEndedPatch,
  SessionTerminalRunStatus,
} from './types.js'

export const STOP_SEALED_SYSTEM_TEXT = '生成已停止'

/** 与 backend ``resolve_terminal_run_status`` 对齐 */
export function resolveTerminalRunStatus(
  opts: Pick<SessionRunEndedOpts, 'reason' | 'aborted' | 'failed' | 'terminalStatus'> = {},
): SessionTerminalRunStatus {
  const explicit = String(opts.terminalStatus || '').trim().toLowerCase()
  if (explicit === 'success') return 'success'
  if (explicit === 'fail' || explicit === 'failed' || explicit === 'error') return 'fail'
  if (
    explicit === 'cancelled' ||
    explicit === 'canceled' ||
    explicit === 'stopped' ||
    explicit === 'aborted'
  ) {
    return explicit === 'stopped' ? 'stopped' : 'cancelled'
  }
  if (explicit === 'done') return 'done'

  const r = String(opts.reason || '').trim().toLowerCase()
  const blob = r
  if (opts.aborted) return 'cancelled'
  if (opts.failed) return 'fail'
  if (
    r === 'user_stop' ||
    r === 'stop' ||
    r === 'cancelled' ||
    r === 'stopped' ||
    r.includes('user_stop') ||
    r.includes('client_disconnect') ||
    r.includes('client_restart') ||
    r.includes('client_attach')
  ) {
    return 'cancelled'
  }
  if (r === 'error' || r === 'fail' || r === 'failed' || blob.includes('error') || blob.includes('fail')) {
    return 'fail'
  }
  if (r === 'success') return 'success'
  return 'done'
}

export function createSessionRunEndedPatch(
  opts?: string | SessionRunEndedOpts,
): SessionRunEndedPatch {
  const normalized: SessionRunEndedOpts =
    typeof opts === 'string' ? { endedAt: opts } : (opts ?? {})
  return {
    runStatus: resolveTerminalRunStatus(normalized),
    currentRunId: null,
    currentTurnEndedAt: normalized.endedAt ?? new Date().toISOString(),
  }
}

export function patchSessionListRunEnded<T extends { sessionKey?: string }>(
  sessions: T[],
  sessionKey: string,
  opts?: string | SessionRunEndedOpts,
): T[] {
  const sk = String(sessionKey || '').trim()
  if (!sk) return sessions
  const patch = createSessionRunEndedPatch(opts)
  return sessions.map((s) => (String(s.sessionKey || '') === sk ? { ...s, ...patch } : s))
}

export function clearSessionExecutionStateForEnded(sessionKey: string): void {
  clearSessionExecutionProbe(String(sessionKey || '').trim())
}

/** 用户点停止 / 网络 abort 开始时：立刻进入 stopped phase，避免 UI 仍显示处理中 */
export function beginSessionUserStop(sessionKey: string): {
  runtime: SessionRuntime
  stopRunId: string | null
} {
  const sk = String(sessionKey || '').trim()
  markSessionRecoveryCooldown(sk)
  seedSessionRuntimeStatusIdle(sk)
  dispatchSessionTurnEvent(sk, { type: 'TURN_ABORTED' })
  const rt = getSessionRuntime(sk)
  const stopRunId = String(rt.activeChatRunId || rt.stream.runId || '').trim() || null
  if (stopRunId) rtAddStoppedRun(rt, stopRunId)
  return { runtime: rt, stopRunId }
}

/** 停止 / 正常结束共用：runtime 落 idle + 可选 reattach 冷却 */
export function finishSessionRunIdle(
  sessionKey: string,
  opts: { stopRunId?: string | null; reattachCooldownMs?: number } = {},
): SessionRuntime {
  const sk = String(sessionKey || '').trim()
  const rt = getSessionRuntime(sk)
  dispatchSessionTurnEvent(sk, { type: 'TURN_ABORTED' })
  dispatchSessionTurnEvent(sk, { type: 'TURN_IDLE' })
  clearActiveRun(rt)
  const runId = opts.stopRunId ?? rt.activeChatRunId ?? rt.stream.runId
  if (runId) {
    rtAddStoppedRun(rt, String(runId))
    if (opts.reattachCooldownMs != null && opts.reattachCooldownMs > 0) {
      markStreamReattachCooldown(sk, String(runId), opts.reattachCooldownMs)
    }
  }
  return rt
}

export function dispatchSessionRunEnded(sessionKey: string): void {
  dispatchSessionTurnEvent(String(sessionKey || '').trim(), { type: 'TURN_IDLE' })
}

/** 流式正常结束 / 错误收尾：runtime idle + 可选会话行 patch（不含 stop 封存逻辑） */
export function finalizeSessionTurnEnded(
  sessionKey: string,
  opts: { stopRunId?: string | null; clearActiveRun?: boolean } = {},
): ReturnType<typeof getSessionRuntime> {
  const sk = String(sessionKey || '').trim()
  const rt = getSessionRuntime(sk)
  dispatchSessionRunEnded(sk)
  if (opts.clearActiveRun !== false) {
    clearActiveRun(rt)
  }
  const runId = opts.stopRunId ?? rt.activeChatRunId ?? rt.stream.runId
  if (runId) rtAddStoppedRun(rt, String(runId))
  return rt
}

/** 用户/网络 abort：TURN_ABORTED + runtime idle */
export function abortSessionTurnEnded(
  sessionKey: string,
  opts: { stopRunId?: string | null; clearActiveRun?: boolean } = {},
): ReturnType<typeof getSessionRuntime> {
  const sk = String(sessionKey || '').trim()
  dispatchSessionTurnEvent(sk, { type: 'TURN_ABORTED' })
  return finalizeSessionTurnEnded(sk, opts)
}

/** 流式 final / error / aborted 收尾：可选 abort + idle + 会话行 patch */
export function completeStreamTurnEnded<T extends { sessionKey?: string }>(
  sessions: T[],
  sessionKey: string,
  opts: {
    endedAt?: string
    aborted?: boolean
    failed?: boolean
    stopRunId?: string | null
    clearActiveRun?: boolean
    clearProbe?: boolean
  } = {},
): { runtime: ReturnType<typeof getSessionRuntime>; sessions: T[] } {
  const sk = String(sessionKey || '').trim()
  const rt = opts.aborted
    ? abortSessionTurnEnded(sk, { stopRunId: opts.stopRunId, clearActiveRun: opts.clearActiveRun })
    : finalizeSessionTurnEnded(sk, { stopRunId: opts.stopRunId, clearActiveRun: opts.clearActiveRun })
  if (opts.clearProbe !== false) clearSessionExecutionStateForEnded(sk)
  const nextSessions = patchSessionListRunEnded(sessions, sk, {
    endedAt: opts.endedAt,
    aborted: opts.aborted,
    failed: opts.failed,
  })
  return { runtime: rt, sessions: nextSessions }
}
