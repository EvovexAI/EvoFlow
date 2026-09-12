/**
 * Unified attach/resume for running sessions (refresh, session switch, task jump).
 *
 * 刷新后默认只轮询 messages / execution-state（history watch），不再依赖 stream-resume SSE。
 * stream-resume 接口本身也只是服务端历史轮询包装，与前端拉 messages 等价，且易被路由吞成 404。
 */
import { bindActiveRun } from './run-turn-gate.js'
import {
  dispatchSessionTurnEvent,
  getSessionRuntime,
  isTurnBusy,
} from './session-runtime-store.js'
import { srLog, srWarn } from './stream-resume-debug.js'
import { shouldSuppressAutoReattach } from './stream-resume-gate.js'
import { isSessionRecoveryCooldownActive, isStreamReattachCooldownActive } from './stream-reattach-cooldown.js'

/** 进行中的 history-watch AbortController（按 sessionKey），供切换会话/卸载时中断 */
const historyWatchAbortBySession = new Map<string, AbortController>()

export function abortSessionHistoryWatch(sessionKey: string): void {
  const key = String(sessionKey || '').trim()
  if (!key) return
  const ctrl = historyWatchAbortBySession.get(key)
  if (!ctrl) return
  try {
    ctrl.abort()
  } catch {
    /* ignore */
  }
  historyWatchAbortBySession.delete(key)
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = window.setTimeout(() => resolve(), ms)
    const onAbort = () => {
      window.clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export type RuntimeStatusResponse = {
  sessionKey?: string
  threadId?: string | null
  runId?: string | null
  runStatus?: string | null
  /** Unified with backend execution/state */
  phase?: string | null
  executing?: boolean
  stopAllowed?: boolean
  gatewayStreamActive?: boolean
  attachRecommended?: boolean
  streamResumeRecommended?: boolean
  goalActive?: boolean
  /** @deprecated 使用 goalActive */
  hostedActive?: boolean
  awaitingToolApproval?: boolean
  langgraphActive?: boolean | null
  snapshotAvailable?: boolean
  latestPartialText?: string
  latestToolSummary?: string
  lastEventAtMs?: number
  /** ISO8601 — current turn wall-clock start (evoflow_chat_sessions.current_turn_started_at) */
  currentTurnStartedAt?: string | null
  /** ISO8601 — latest turn wall-clock end */
  currentTurnEndedAt?: string | null
}

const RUNTIME_STATUS_MIN_INTERVAL_MS = 4500
const runtimeStatusCache = new Map<
  string,
  { until: number; data: RuntimeStatusResponse | null }
>()

function idleRuntimeStatusFallback(sessionKey: string): RuntimeStatusResponse {
  return {
    sessionKey,
    runStatus: 'done',
    phase: 'done',
    executing: false,
    stopAllowed: false,
    gatewayStreamActive: false,
    attachRecommended: false,
    streamResumeRecommended: false,
    langgraphActive: false,
    hostedActive: false,
    goalActive: false,
    awaitingToolApproval: false,
    snapshotAvailable: false,
  }
}

const EXECUTION_STATE_PATH = '/execution/state'

export async function fetchSessionExecutionState(
  sessionKey: string,
  opts?: { bypassCache?: boolean },
): Promise<RuntimeStatusResponse | null> {
  return fetchSessionRuntimeStatus(sessionKey, opts)
}

export async function fetchSessionRuntimeStatus(
  sessionKey: string,
  opts?: { bypassCache?: boolean },
): Promise<RuntimeStatusResponse | null> {
  const sk = String(sessionKey || '').trim()
  if (!sk) return null
  const now = Date.now()
  const cached = runtimeStatusCache.get(sk)
  if (!opts?.bypassCache && cached && cached.until > now) {
    return cached.data
  }
  if (isSessionRecoveryCooldownActive(sk)) {
    return cached?.data ?? idleRuntimeStatusFallback(sk)
  }
  try {
    const { gatewayJson } = await import('../../lib/gateway-json.js')
    const data = (await gatewayJson(
      'GET',
      `/api/chat/sessions/${encodeURIComponent(sk)}${EXECUTION_STATE_PATH}`,
    )) as RuntimeStatusResponse & { ok?: boolean }
    const out = data?.ok === false ? null : data
    runtimeStatusCache.set(sk, { until: now + RUNTIME_STATUS_MIN_INTERVAL_MS, data: out })
    return out
  } catch {
    return cached?.data ?? null
  }
}

export function invalidateSessionRuntimeStatusCache(sessionKey?: string): void {
  const sk = String(sessionKey || '').trim()
  if (sk) runtimeStatusCache.delete(sk)
  else runtimeStatusCache.clear()
}

/** After user stop: seed idle so in-flight pollers skip backend LangGraph runs probe. */
export function seedSessionRuntimeStatusIdle(sessionKey: string): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  runtimeStatusCache.set(sk, {
    until: Date.now() + RUNTIME_STATUS_MIN_INTERVAL_MS,
    data: idleRuntimeStatusFallback(sk),
  })
}

export type SessionRowLike = {
  sessionKey?: string
  runStatus?: string | null
  currentRunId?: string | null
  threadId?: string | null
}

export type ReattachResult = 'attached' | 'idle' | 'degraded' | 'error' | 'skipped'

export type TranscriptResumeAnchor = {
  persistedTurnText?: string
  persistedToolCallIds?: string[]
}

export type WsClientReattach = {
  getSessionThreadId(sessionKey: string): string | null | undefined
  ensureChatThread(sessionKey: string): Promise<string | null | undefined>
  resumeChatStream(
    sessionKey: string,
    opts: {
      runId: string
      threadId?: string | null
      controller?: AbortController
      transcriptAnchor?: TranscriptResumeAnchor | null
      resumeReason?: string
      /** History-poll: refresh UI from latest DB messages while run still active. */
      onHistorySnapshot?: (snapshot: Record<string, unknown>) => void | Promise<void>
    },
  ): Promise<{
    ok?: boolean
    aborted?: boolean
    completed?: Record<string, unknown>
    resumeUnavailable?: { reason?: string }
    runId?: string
  }>
}

const ACTIVE_STATUSES = new Set(['running', 'pending'])

const TERMINAL_RUN_STATUSES = new Set([
  'done',
  'success',
  'fail',
  'failed',
  'cancelled',
  'canceled',
  'idle',
  'error',
  'aborted',
  'stopped',
])

export function isActiveRunStatus(status: string | null | undefined): boolean {
  return ACTIVE_STATUSES.has(String(status || '').trim().toLowerCase())
}

/** Backend / session list terminal states — do not probe LangGraph ``/runs`` after these. */
export function isTerminalRunStatus(status: string | null | undefined): boolean {
  const st = String(status || '').trim().toLowerCase()
  return !!st && TERMINAL_RUN_STATUSES.has(st)
}

export async function isSessionRunStillActive(sessionKey: string): Promise<boolean> {
  const key = String(sessionKey || '').trim()
  if (!key) return false
  if (isSessionRecoveryCooldownActive(key)) return false

  const runtimeStatus = await fetchSessionRuntimeStatus(key)
  const dbStatus = String(runtimeStatus?.runStatus || '').trim().toLowerCase()
  return isActiveRunStatus(dbStatus)
}

export type MaybeClearTurnSendingResult = 'cleared' | 'resumed' | 'forced'

export async function maybeClearTurnSendingState(opts: {
  sessionKey: string
  wsClient: WsClientReattach
  force?: boolean
  onClear: () => void
  onResume: () => void
}): Promise<MaybeClearTurnSendingResult> {
  const key = String(opts.sessionKey || '').trim()
  if (!key) return 'cleared'
  if (opts.force) {
    opts.onClear()
    return 'forced'
  }
  const stillActive = await isSessionRunStillActive(key)
  if (stillActive) {
    srLog('maybeClearTurnSendingState — run still active, resuming', { sessionKey: key })
    opts.onResume()
    return 'resumed'
  }
  opts.onClear()
  return 'cleared'
}

export function resolveRunIdsFromStatus(st: {
  runId?: string | null
  status?: string
  run?: { run_id?: string; runId?: string; status?: string } | null
} | null | undefined): { runId: string | null; status: string } {
  const runId = String(st?.runId || st?.run?.run_id || st?.run?.runId || '').trim() || null
  const status = String(st?.status || st?.run?.status || 'idle').trim().toLowerCase()
  return { runId, status }
}

export async function reattachRunningSessionIfNeeded(opts: {
  sessionKey: string
  wsClient: WsClientReattach
  sessionRow?: SessionRowLike | null
  skipIfAlreadyAttached?: boolean
  reloadHistory?: (runId: string) => Promise<{ transcriptAnchor?: TranscriptResumeAnchor | null } | void>
  resumeReason?: string
  /** 手动刷新(F5/侧栏刷新按钮)：跳过 recovery cooldown 与 suppress 检查，绕过缓存查 DB */
  manualForce?: boolean
  /** history-watch 轮询间隔（默认 1500ms） */
  historyPollIntervalMs?: number
  /** history-watch 最大轮次；仍在跑则保持 degraded（默认 480 ≈ 12min） */
  historyPollMaxAttempts?: number
}): Promise<ReattachResult> {
  const key = String(opts.sessionKey || '').trim()
  if (!key) return 'skipped'
  const manualForce = !!opts.manualForce
  if (!manualForce && isSessionRecoveryCooldownActive(key)) {
    srLog('reattach skipped — session recovery cooldown', { sessionKey: key })
    return 'skipped'
  }

  srLog('reattachRunningSessionIfNeeded enter', {
    sessionKey: key,
    rowRunStatus: opts.sessionRow?.runStatus ?? null,
    rowRunId: opts.sessionRow?.currentRunId ?? null,
    rowThreadId: opts.sessionRow?.threadId ?? null,
    manualForce,
    mode: 'history-watch',
  })

  if (shouldSuppressAutoReattach({ sessionKey: key, manualForce })) {
    srLog('reattach skipped — live POST stream', { sessionKey: key })
    return 'skipped'
  }

  const row = opts.sessionRow
  let threadId = String(row?.threadId || opts.wsClient.getSessionThreadId(key) || '').trim() || null
  let runId = String(row?.currentRunId || '').trim() || null
  if (runId && isStreamReattachCooldownActive(key, runId)) {
    srLog('reattach skipped — cooldown', { sessionKey: key, runId })
    return 'skipped'
  }
  let status = String(row?.runStatus || '').trim().toLowerCase()

  const runtimeStatus = await fetchSessionRuntimeStatus(key, { bypassCache: manualForce })
  if (runtimeStatus) {
    srLog('runtime-status', {
      sessionKey: key,
      runStatus: runtimeStatus.runStatus,
      runId: runtimeStatus.runId,
      threadId: runtimeStatus.threadId,
      attachRecommended: runtimeStatus.attachRecommended,
      streamResumeRecommended: runtimeStatus.streamResumeRecommended,
      hostedActive: runtimeStatus.hostedActive ?? runtimeStatus.goalActive,
      goalActive: runtimeStatus.goalActive ?? runtimeStatus.hostedActive,
      langgraphActive: runtimeStatus.langgraphActive,
      manualForce,
    })
    if (!threadId) threadId = String(runtimeStatus.threadId || '').trim() || null
    if (!runId) runId = String(runtimeStatus.runId || '').trim() || null
    if (!status || status === 'idle') {
      status = String(runtimeStatus.runStatus || '').trim().toLowerCase()
    }
    if (!isActiveRunStatus(status)) {
      srLog('reattach idle — DB run_status not active', {
        sessionKey: key,
        runStatus: status,
      })
      dispatchSessionTurnEvent(key, { type: 'TURN_IDLE' })
      return 'idle'
    }
  }

  if (!threadId) {
    try {
      const ensured = String((await opts.wsClient.ensureChatThread(key)) || '').trim()
      if (ensured) threadId = ensured
    } catch {
      /* keep threadId from status row */
    }
  }

  if (!threadId || !runId || !isActiveRunStatus(status)) {
    srWarn('reattach idle — missing ids or not active', {
      sessionKey: key,
      threadId,
      runId,
      status,
    })
    dispatchSessionTurnEvent(key, { type: 'TURN_IDLE' })
    return 'idle'
  }

  if (isStreamReattachCooldownActive(key, runId)) {
    srLog('reattach skipped — cooldown after status resolve', { sessionKey: key, runId })
    return 'skipped'
  }

  const rt = getSessionRuntime(key)
  if (
    opts.skipIfAlreadyAttached &&
    (rt.turnPhase === 'live' || rt.turnPhase === 'degraded') &&
    String(rt.activeChatRunId || '') === runId &&
    String(rt.attachedThreadId || '') === threadId
  ) {
    srLog('reattach skipped — already watching', { sessionKey: key, runId, threadId, turnPhase: rt.turnPhase })
    return 'skipped'
  }

  bindActiveRun(rt, runId)
  abortSessionHistoryWatch(key)
  const controller = new AbortController()
  historyWatchAbortBySession.set(key, controller)

  srLog('reattach history-watch (no stream-resume)', {
    sessionKey: key,
    runId,
    threadId,
    reason: opts.resumeReason ?? null,
  })
  dispatchSessionTurnEvent(key, {
    type: 'REATTACH_STARTED',
    runId,
    threadId,
  })

  const reloadSafe = async () => {
    if (!opts.reloadHistory) return
    try {
      await opts.reloadHistory(runId)
    } catch (err) {
      srWarn('reattach history reload failed', {
        sessionKey: key,
        error: String(err instanceof Error ? err.message : err),
      })
    }
  }

  try {
    await reloadSafe()
    invalidateSessionRuntimeStatusCache(key)
    if (!(await isSessionRunStillActive(key))) {
      await reloadSafe()
      dispatchSessionTurnEvent(key, { type: 'TURN_IDLE' })
      return 'idle'
    }

    dispatchSessionTurnEvent(key, { type: 'REATTACH_DEGRADED', runId, threadId })

    const intervalMs = Math.max(400, opts.historyPollIntervalMs ?? 1500)
    const maxAttempts = Math.max(1, opts.historyPollMaxAttempts ?? 480)
    for (let i = 0; i < maxAttempts; i += 1) {
      if (controller.signal.aborted) {
        srLog('reattach history-watch aborted', { sessionKey: key, runId })
        return 'skipped'
      }
      try {
        await sleepAbortable(intervalMs, controller.signal)
      } catch {
        srLog('reattach history-watch aborted during sleep', { sessionKey: key, runId })
        return 'skipped'
      }
      await reloadSafe()
      invalidateSessionRuntimeStatusCache(key)
      if (!(await isSessionRunStillActive(key))) {
        await reloadSafe()
        dispatchSessionTurnEvent(key, { type: 'TURN_IDLE' })
        srLog('reattach history-watch idle', { sessionKey: key, runId, polls: i + 1 })
        return 'idle'
      }
    }

    srLog('reattach history-watch still running after max polls', {
      sessionKey: key,
      runId,
      maxAttempts,
    })
    return 'degraded'
  } catch (err) {
    if (controller.signal.aborted) return 'skipped'
    srWarn('reattach history-watch failed', {
      sessionKey: key,
      error: String(err instanceof Error ? err.message : err),
    })
    dispatchSessionTurnEvent(key, { type: 'REATTACH_FAILED', threadId })
    await reloadSafe()
    dispatchSessionTurnEvent(key, { type: 'REATTACH_DEGRADED', runId, threadId })
    return 'degraded'
  } finally {
    if (historyWatchAbortBySession.get(key) === controller) {
      historyWatchAbortBySession.delete(key)
    }
  }
}

/**
 * Try to watch a running session using a known runId (from resume_run_id).
 * History-only — no stream-resume SSE.
 */
async function tryAttachByRunId(
  sessionKey: string,
  threadId: string,
  runId: string,
  wsClient: WsClientReattach,
  resumeReason?: string,
  reloadHistory?: (runId: string) => Promise<{ transcriptAnchor?: TranscriptResumeAnchor | null } | void>,
): Promise<ReattachResult | null> {
  if (!runId || !threadId) return null
  return await reattachRunningSessionIfNeeded({
    sessionKey,
    wsClient,
    sessionRow: { threadId, currentRunId: runId, runStatus: 'running' },
    reloadHistory,
    resumeReason: resumeReason ?? 'hint_run_id',
    historyPollMaxAttempts: 1,
  })
}

export async function pollReattachRunningSession(opts: {
  sessionKey: string
  threadId: string
  wsClient: WsClientReattach
  maxAttempts?: number
  intervalMs?: number
  hintRunId?: string
  reloadHistory?: (runId: string) => Promise<{ transcriptAnchor?: TranscriptResumeAnchor | null } | void>
  resumeReason?: string
}): Promise<ReattachResult> {
  const pollReason = opts.resumeReason ?? 'poll_wait_run'
  // If a hint runId is provided, try direct attach first (avoids polling entirely)
  if (opts.hintRunId) {
    const direct = await tryAttachByRunId(
      opts.sessionKey,
      opts.threadId,
      opts.hintRunId,
      opts.wsClient,
      'hint_run_id',
      opts.reloadHistory,
    )
    if (direct === 'attached' || direct === 'degraded' || direct === 'idle') return direct
  }
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 60)
  const intervalMs = Math.max(200, opts.intervalMs ?? 3000)
  for (let i = 0; i < maxAttempts; i += 1) {
    const result = await reattachRunningSessionIfNeeded({
      sessionKey: opts.sessionKey,
      wsClient: opts.wsClient,
      sessionRow: { threadId: opts.threadId },
      skipIfAlreadyAttached: true,
      reloadHistory: opts.reloadHistory,
      resumeReason: pollReason,
      historyPollMaxAttempts: 1,
      historyPollIntervalMs: 50,
    })
    if (result === 'attached' || result === 'degraded' || result === 'idle') return result
    if (i < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, intervalMs))
    }
  }
  return 'error'
}

/** True when local turn phase indicates an in-flight user-visible turn. */
export function isSessionTurnInFlight(sessionKey: string): boolean {
  return isTurnBusy(getSessionRuntime(sessionKey))
}
