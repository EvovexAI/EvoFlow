/**
 * runId gate: only events for the current active run should write into live turn state.
 */
import type { ChatWsPayload } from '../chat-types.js'
import type { SessionRuntime } from './session-runtime-store.js'
import { rtIsStoppedRun } from './session-runtime-store.js'

export type LiveRunStatus = 'streaming' | 'sealing' | null

export function isAgUiWireRunId(runId: string): boolean {
  return /^run-[a-f0-9]+$/i.test(String(runId || '').trim())
}

/** chatSend client UUID 与 AG-UI wire run-{hex} 同轮双 id */
export function chatRunIdsSameTurn(active: string, incoming: string): boolean {
  const a = String(active || '').trim()
  const b = String(incoming || '').trim()
  if (!a || !b) return false
  if (a === b) return true
  return (
    (isAgUiWireRunId(a) && !isAgUiWireRunId(b)) ||
    (isAgUiWireRunId(b) && !isAgUiWireRunId(a))
  )
}

export function shouldApplyChatEvent(
  rt: SessionRuntime,
  payload: ChatWsPayload | null | undefined,
  opts: {
    allowSealingTerminal?: boolean
    knownRunId?: string | null
    /** 新发送后、run_started 绑定前：只接受本轮 expected run，避免旧 run delta 写入新 stream */
    expectedRunId?: string | null
  } = {},
): boolean {
  const runId = String(payload?.runId || '').trim()
  if (!runId) return false
  if (rtIsStoppedRun(rt, runId)) return false

  const active = String(rt.activeChatRunId || '').trim()
  const known = String(opts.knownRunId || '').trim()
  const expected = String(opts.expectedRunId || '').trim()
  const state = payload?.state
  const isFreshSend = rt.turnPhase === 'outbound'
  if (!active) {
    if (state === 'run_started') return true
    if (isFreshSend && state !== 'run_started') {
      return !!expected && (runId === expected || chatRunIdsSameTurn(expected, runId))
    }
    if (known && (runId === known || chatRunIdsSameTurn(known, runId))) return true
    if (
      opts.allowSealingTerminal &&
      (state === 'final' || state === 'aborted') &&
      expected &&
      chatRunIdsSameTurn(expected, runId)
    ) {
      return true
    }
    return false
  }
  if (runId !== active) {
    // AG-UI SSE 使用 run-{hex}，chatSend 先绑 client UUID；同轮双 id 须互通
    if (state === 'agui_event' && chatRunIdsSameTurn(active, runId)) {
      return true
    }
    if (
      opts.allowSealingTerminal &&
      (state === 'final' || state === 'aborted') &&
      chatRunIdsSameTurn(active, runId)
    ) {
      return true
    }
    return false
  }

  if (opts.allowSealingTerminal && (state === 'final' || state === 'aborted')) {
    return true
  }
  if (rt.liveRunStatus === 'sealing') {
    return state === 'final' || state === 'aborted'
  }
  return true
}

export function bindActiveRun(rt: SessionRuntime, runId: string | null | undefined): void {
  const id = String(runId || '').trim()
  if (!id) return
  rt.activeChatRunId = id
  rt.liveRunStatus = 'streaming'
}

export function markRunSealing(rt: SessionRuntime): void {
  if (rt.activeChatRunId) rt.liveRunStatus = 'sealing'
}

export function clearActiveRun(rt: SessionRuntime): void {
  rt.activeChatRunId = null
  rt.liveRunStatus = null
}
