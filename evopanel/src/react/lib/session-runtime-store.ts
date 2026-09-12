/**
 * Per-session chat UI runtime — single source of truth for turn lifecycle.
 *
 * All busy/spinner/stop/processing UI derives from ``turnPhase`` (+ optional DB cold bootstrap).
 * SSE, send(), abort, and reattach dispatch events through ``dispatchSessionTurnEvent`` only.
 */

import type { DisplayRow, StreamState } from '../chat-types.js'
import { SESSION_RUNNING_ACTIVITY_LABEL } from './resolve-live-stream-activity.js'
import { emptyStream, streamRefHasVisibleContent } from './stream-state.js'
import type { LiveRunStatus } from './run-turn-gate.js'

const ACTIVE_RUN_STATUSES = new Set(['running', 'pending'])

function isDbRunActive(status: string | null | undefined): boolean {
  return ACTIVE_RUN_STATUSES.has(String(status || '').trim().toLowerCase())
}

/** Previous-turn assistant body/reasoning/tool ids to strip from the next live turn. */
export type PriorTurnStrip = {
  body: string
  reasoning: string
  toolIds: string[]
}

export const EMPTY_PRIOR_TURN_STRIP: PriorTurnStrip = {
  body: '',
  reasoning: '',
  toolIds: [],
}

/** Authoritative turn lifecycle — all busy UI reads this. */
export type TurnPhase =
  | 'idle'
  | 'outbound'
  | 'live'
  | 'reattaching'
  | 'sealing'
  | 'stopped'
  | 'degraded'
  | 'error'

/** @deprecated Use TurnPhase — kept for type compatibility during migration. */
export type SessionAttachState = 'idle' | 'attaching' | 'attached' | 'detached' | 'error'

export type StreamWireSource = 'run' | 'attach' | 'stream-resume' | null

export type SessionTurnActivity = {
  kind: string
  detail: string
}

export type SessionRecoveryPhase =
  | 'idle'
  | 'running_unattached'
  | 'attaching'
  | 'live_attached'
  | 'degraded_snapshot_only'
  | 'completed'

export type SessionRuntime = {
  rows: DisplayRow[]
  stream: StreamState
  turnPhase: TurnPhase
  activity: SessionTurnActivity
  seenRunIds: string[]
  stoppedRunIds: string[]
  staleToolCallIds: string[]
  activeChatRunId: string | null
  liveRunStatus: LiveRunStatus
  priorTurnStrip: PriorTurnStrip
  attachedThreadId: string | null
  lastEventAt: number | null
  lastVisibleTextPreview: string
  lastToolPreview: string
  turnStartTs: number | null
  resumeCatchupReplay: boolean
  streamWireSource: StreamWireSource
}

export type SessionTurnEvent =
  | { type: 'SEND_STARTED'; turnStartTs?: number }
  | { type: 'RUN_LIVE'; runId: string; threadId?: string | null; wireSource?: StreamWireSource }
  | { type: 'REATTACH_STARTED'; runId: string; threadId?: string | null }
  | { type: 'REATTACH_LIVE'; runId: string; threadId?: string | null }
  | { type: 'REATTACH_DEGRADED'; runId?: string | null; threadId?: string | null }
  | { type: 'REATTACH_FAILED'; threadId?: string | null }
  | { type: 'SEALING' }
  | { type: 'TURN_IDLE' }
  | { type: 'TURN_ABORTED' }
  | { type: 'SEND_FAILED' }
  | { type: 'ACTIVITY'; kind: string; detail: string }
  | { type: 'WIRE_SOURCE'; source: StreamWireSource }
  | { type: 'RESUME_CATCHUP'; active: boolean }
  | {
      type: 'SESSION_EVENT'
      at?: number | null
      textPreview?: string | null
      toolPreview?: string | null
    }

const BUSY_PHASES = new Set<TurnPhase>(['outbound', 'live', 'reattaching', 'sealing'])

const store = new Map<string, SessionRuntime>()
let epoch = 0
const listeners = new Set<() => void>()
/** Bumps only on immediate turn lifecycle (executing list / stop button), not per-delta. */
let executingListEpoch = 0
const executingListListeners = new Set<() => void>()

/** Coalesce high-frequency runtime notifies (SSE deltas / background activity). */
const RUNTIME_NOTIFY_IDLE_MS = 200
let notifyRafId = 0
let notifyTimeoutId = 0
let notifyCoalesced = false

function clearNotifyTimers(): void {
  if (notifyRafId) {
    try {
      cancelAnimationFrame(notifyRafId)
    } catch {
      /* ignore */
    }
    notifyRafId = 0
  }
  if (notifyTimeoutId) {
    clearTimeout(notifyTimeoutId)
    notifyTimeoutId = 0
  }
}

function fireNotify(): void {
  clearNotifyTimers()
  notifyCoalesced = false
  epoch += 1
  listeners.forEach((fn) => {
    try {
      fn()
    } catch {
      /* ignore */
    }
  })
}

function fireExecutingListNotify(): void {
  executingListEpoch += 1
  executingListListeners.forEach((fn) => {
    try {
      fn()
    } catch {
      /* ignore */
    }
  })
}

type NotifyOptions = { immediate?: boolean }

function notify(opts?: NotifyOptions): void {
  if (opts?.immediate) {
    fireNotify()
    fireExecutingListNotify()
    return
  }
  if (notifyCoalesced) return
  notifyCoalesced = true
  notifyRafId = requestAnimationFrame(() => {
    notifyRafId = 0
    notifyTimeoutId = window.setTimeout(fireNotify, RUNTIME_NOTIFY_IDLE_MS)
  })
}

const sessionEpochs = new Map<string, number>()
const sessionListeners = new Map<string, Set<() => void>>()
const sessionNotifyTimers = new Map<
  string,
  { coalesced: boolean; rafId: number; timeoutId: number }
>()

function clearSessionNotifyTimers(sk: string): void {
  const state = sessionNotifyTimers.get(sk)
  if (!state) return
  if (state.rafId) {
    try {
      cancelAnimationFrame(state.rafId)
    } catch {
      /* ignore */
    }
    state.rafId = 0
  }
  if (state.timeoutId) {
    clearTimeout(state.timeoutId)
    state.timeoutId = 0
  }
}

function fireSessionNotify(sk: string): void {
  clearSessionNotifyTimers(sk)
  const state = sessionNotifyTimers.get(sk)
  if (state) state.coalesced = false
  sessionEpochs.set(sk, (sessionEpochs.get(sk) ?? 0) + 1)
  sessionListeners.get(sk)?.forEach((fn) => {
    try {
      fn()
    } catch {
      /* ignore */
    }
  })
}

function notifySession(sessionKey: string, opts?: NotifyOptions): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  if (opts?.immediate) {
    fireSessionNotify(sk)
    return
  }
  let state = sessionNotifyTimers.get(sk)
  if (!state) {
    state = { coalesced: false, rafId: 0, timeoutId: 0 }
    sessionNotifyTimers.set(sk, state)
  }
  if (state.coalesced) return
  state.coalesced = true
  state.rafId = requestAnimationFrame(() => {
    state!.rafId = 0
    state!.timeoutId = window.setTimeout(() => fireSessionNotify(sk), RUNTIME_NOTIFY_IDLE_MS)
  })
}

function dispatchRuntimeNotify(sessionKey: string, event: SessionTurnEvent): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  if (isImmediateTurnEvent(event)) {
    notify({ immediate: true })
    notifySession(sk, { immediate: true })
    return
  }
  if (
    event.type === 'ACTIVITY' ||
    event.type === 'SESSION_EVENT' ||
    event.type === 'WIRE_SOURCE' ||
    event.type === 'RESUME_CATCHUP'
  ) {
    notifySession(sk)
    return
  }
  notify()
  notifySession(sk)
}

export function subscribeSessionRuntimeForKey(
  sessionKey: string,
  listener: () => void,
): () => void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return () => {}
  let set = sessionListeners.get(sk)
  if (!set) {
    set = new Set()
    sessionListeners.set(sk, set)
  }
  set.add(listener)
  return () => {
    set!.delete(listener)
    if (set!.size === 0) sessionListeners.delete(sk)
  }
}

export function getSessionRuntimeEpochForKey(sessionKey: string): number {
  return sessionEpochs.get(String(sessionKey || '').trim()) ?? 0
}

export function bumpSessionRuntimeNotifyForKey(
  sessionKey: string,
  opts?: NotifyOptions,
): void {
  notifySession(sessionKey, opts)
}

function isImmediateTurnEvent(event: SessionTurnEvent): boolean {
  switch (event.type) {
    case 'SEND_STARTED':
    case 'RUN_LIVE':
    case 'REATTACH_STARTED':
    case 'REATTACH_LIVE':
    case 'REATTACH_DEGRADED':
    case 'REATTACH_FAILED':
    case 'SEALING':
    case 'TURN_ABORTED':
    case 'SEND_FAILED':
    case 'TURN_IDLE':
      return true
    default:
      return false
  }
}

export function subscribeSessionRuntime(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getSessionRuntimeEpoch(): number {
  return epoch
}

/** Subscribe to executing-session list changes (turn start/stop only). */
export function subscribeExecutingListRuntime(listener: () => void): () => void {
  executingListListeners.add(listener)
  return () => {
    executingListListeners.delete(listener)
  }
}

export function getExecutingListRuntimeEpoch(): number {
  return executingListEpoch
}

export function bumpSessionRuntimeNotify(opts?: NotifyOptions): void {
  notify(opts)
}

/** Flush any coalesced runtime notify (e.g. before reading epoch in tests). */
export function flushPendingSessionRuntimeNotify(): void {
  if (!notifyCoalesced) return
  fireNotify()
}

export function createEmptySessionRuntime(): SessionRuntime {
  return {
    rows: [],
    stream: emptyStream(),
    turnPhase: 'idle',
    activity: { kind: 'idle', detail: '' },
    seenRunIds: [],
    stoppedRunIds: [],
    staleToolCallIds: [],
    activeChatRunId: null,
    liveRunStatus: null,
    priorTurnStrip: { ...EMPTY_PRIOR_TURN_STRIP },
    attachedThreadId: null,
    lastEventAt: null,
    lastVisibleTextPreview: '',
    lastToolPreview: '',
    turnStartTs: null,
    resumeCatchupReplay: false,
    streamWireSource: null,
  }
}

export function getSessionRuntime(sessionKey: string): SessionRuntime {
  const sk = String(sessionKey || '').trim()
  if (!sk) return createEmptySessionRuntime()
  let rt = store.get(sk)
  if (!rt) {
    rt = createEmptySessionRuntime()
    store.set(sk, rt)
  }
  return rt
}

/** True when UI should show spinner / stop / processing dock. */
export function isTurnBusy(rt: SessionRuntime | undefined | null): boolean {
  if (!rt) return false
  return BUSY_PHASES.has(rt.turnPhase)
}

/** @deprecated Use isTurnBusy */
export function rtIsSending(rt: SessionRuntime | undefined | null): boolean {
  return isTurnBusy(rt)
}

/** Legacy attachState derived from turnPhase (do not write separately). */
export function deriveAttachState(rt: SessionRuntime): SessionAttachState {
  switch (rt.turnPhase) {
    case 'reattaching':
      return 'attaching'
    case 'live':
    case 'outbound':
    case 'sealing':
      return 'attached'
    case 'degraded':
      return 'detached'
    case 'error':
      return 'error'
    default:
      return 'idle'
  }
}

export function isSessionRuntimeLive(rt: SessionRuntime | undefined | null): boolean {
  if (!rt) return false
  return isTurnBusy(rt) || streamRefHasVisibleContent(rt.stream)
}

export function isSessionRuntimeStreamVisible(sessionKey: string): boolean {
  const sk = String(sessionKey || '').trim()
  if (!sk) return false
  return streamRefHasVisibleContent(getSessionRuntime(sk).stream)
}

export function isSessionLive(sessionKey: string): boolean {
  return isSessionRuntimeLive(store.get(String(sessionKey || '').trim()))
}

export function listLiveSessionRuntimeKeys(): string[] {
  const out: string[] = []
  for (const [sk, rt] of store) {
    if (isSessionRuntimeLive(rt)) out.push(sk)
  }
  return out
}

/** List all session keys whose turnPhase is currently busy (spinner/stop UI active). */
export function listBusySessionKeys(): string[] {
  const out: string[] = []
  for (const [sk, rt] of store) {
    if (isTurnBusy(rt)) out.push(sk)
  }
  return out
}

export function clearSessionRuntime(sessionKey: string): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  if (store.delete(sk)) notify({ immediate: true })
}

/**
 * Drop idle runtimes not in ``keepKeys`` (deleted / scrolled-off sessions).
 * Never touches busy or live-stream sessions. Returns number of entries removed.
 */
export function pruneSessionRuntimes(keepKeys: Iterable<string>): number {
  const keep = new Set<string>()
  for (const raw of keepKeys) {
    const sk = String(raw || '').trim()
    if (sk) keep.add(sk)
  }
  let removed = 0
  for (const [sk, rt] of store) {
    if (keep.has(sk)) continue
    if (isTurnBusy(rt) || isSessionRuntimeLive(rt)) continue
    store.delete(sk)
    removed += 1
  }
  if (removed) notify({ immediate: true })
  return removed
}

/** Keys currently held in the runtime store (tests / diagnostics). */
export function listSessionRuntimeKeys(): string[] {
  return [...store.keys()]
}

function clearTurnTiming(rt: SessionRuntime): void {
  rt.turnStartTs = null
  rt.lastVisibleTextPreview = ''
  rt.lastToolPreview = ''
}

function applyTurnIdle(rt: SessionRuntime): void {
  rt.turnPhase = 'idle'
  rt.activity = { kind: 'idle', detail: '' }
  rt.streamWireSource = null
  clearTurnTiming(rt)
}

export function dispatchSessionTurnEvent(sessionKey: string, event: SessionTurnEvent): SessionRuntime {
  const sk = String(sessionKey || '').trim()
  const rt = getSessionRuntime(sk)
  switch (event.type) {
    case 'SEND_STARTED':
      rt.turnPhase = 'outbound'
      rt.activeChatRunId = null
      rt.activity = { kind: 'idle', detail: '' }
      rt.turnStartTs = event.turnStartTs ?? Date.now()
      rt.lastEventAt = Date.now()
      break
    case 'RUN_LIVE':
      rt.turnPhase = 'live'
      rt.activeChatRunId = String(event.runId || '').trim() || null
      if (event.threadId !== undefined) rt.attachedThreadId = event.threadId
      if (event.wireSource !== undefined) rt.streamWireSource = event.wireSource
      rt.lastEventAt = Date.now()
      if (!rt.turnStartTs) rt.turnStartTs = Date.now()
      break
    case 'REATTACH_STARTED':
      rt.turnPhase = 'reattaching'
      rt.activeChatRunId = String(event.runId || '').trim() || null
      if (event.threadId !== undefined) rt.attachedThreadId = event.threadId
      rt.lastEventAt = Date.now()
      if (!rt.turnStartTs) rt.turnStartTs = Date.now()
      break
    case 'REATTACH_LIVE':
      rt.turnPhase = 'live'
      rt.activeChatRunId = String(event.runId || '').trim() || null
      if (event.threadId !== undefined) rt.attachedThreadId = event.threadId
      rt.lastEventAt = Date.now()
      break
    case 'REATTACH_DEGRADED':
      rt.turnPhase = 'degraded'
      if (event.runId !== undefined) rt.activeChatRunId = event.runId
      if (event.threadId !== undefined) rt.attachedThreadId = event.threadId
      rt.streamWireSource = null
      rt.lastEventAt = Date.now()
      clearTurnTiming(rt)
      break
    case 'REATTACH_FAILED':
      rt.turnPhase = 'error'
      if (event.threadId !== undefined) rt.attachedThreadId = event.threadId
      rt.streamWireSource = null
      clearTurnTiming(rt)
      break
    case 'SEALING':
      rt.turnPhase = 'sealing'
      rt.lastEventAt = Date.now()
      break
    case 'TURN_ABORTED':
      rt.turnPhase = 'stopped'
      rt.streamWireSource = null
      rt.lastEventAt = Date.now()
      clearTurnTiming(rt)
      break
    case 'SEND_FAILED':
      rt.turnPhase = 'error'
      rt.activeChatRunId = null
      rt.streamWireSource = null
      clearTurnTiming(rt)
      break
    case 'TURN_IDLE':
      applyTurnIdle(rt)
      break
    case 'ACTIVITY':
      rt.activity = {
        kind: String(event.kind || 'idle').trim().toLowerCase() || 'idle',
        detail: String(event.detail || '').trim(),
      }
      rt.lastEventAt = Date.now()
      break
    case 'WIRE_SOURCE':
      rt.streamWireSource = event.source
      break
    case 'RESUME_CATCHUP':
      rt.resumeCatchupReplay = !!event.active
      break
    case 'SESSION_EVENT':
      if (event.at !== undefined) rt.lastEventAt = event.at
      if (event.textPreview !== undefined && event.textPreview !== null) {
        rt.lastVisibleTextPreview = String(event.textPreview)
      }
      if (event.toolPreview !== undefined && event.toolPreview !== null) {
        rt.lastToolPreview = String(event.toolPreview)
      }
      break
    default:
      break
  }
  dispatchRuntimeNotify(sk, event)
  return rt
}

export function deriveSessionRecoveryPhase(opts: {
  turnPhase?: TurnPhase
  runStatus?: string | null
  snapshotAvailable?: boolean
}): SessionRecoveryPhase {
  const phase = opts.turnPhase || 'idle'
  const running = isDbRunActive(opts.runStatus)
  if (phase === 'reattaching') return 'attaching'
  if (phase === 'live' || phase === 'outbound' || phase === 'sealing') return 'live_attached'
  if (phase === 'degraded' && opts.snapshotAvailable) return 'degraded_snapshot_only'
  if (running && phase === 'idle') return 'running_unattached'
  if (phase === 'degraded') return 'degraded_snapshot_only'
  if (!running && (phase === 'stopped' || phase === 'error')) return 'completed'
  return 'idle'
}

export function recoveryPhaseLabel(phase: SessionRecoveryPhase): string | null {
  switch (phase) {
    case 'running_unattached':
      return '任务仍在后台运行，正在尝试恢复…'
    case 'attaching':
      return '正在恢复…'
    case 'degraded_snapshot_only':
      return '连接已断开，以下为上次进度'
    default:
      return null
  }
}

export function processingLabelForPhase(
  rt: SessionRuntime,
  detail?: string,
): string {
  const phase = rt.turnPhase
  const act = String(detail ?? rt.activity.detail ?? '').trim()
  const kind = String(rt.activity.kind || 'idle').trim().toLowerCase()
  if (phase === 'reattaching') return '正在恢复…'
  if (phase === 'sealing') return act || SESSION_RUNNING_ACTIVITY_LABEL
  if (act && kind !== 'idle') return act
  if (isTurnBusy(rt)) return SESSION_RUNNING_ACTIVITY_LABEL
  return ''
}

export function commitActiveSessionRuntime(
  sessionKey: string,
  snapshot: {
    rows: DisplayRow[]
    stream: StreamState
    seenRunIds: Iterable<string>
    activeChatRunId: string | null
    turnStartTs?: number | null
  },
): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  const rt = getSessionRuntime(sk)
  rt.rows = [...snapshot.rows]
  rt.stream = snapshot.stream
  rt.seenRunIds = [...snapshot.seenRunIds]
  rt.activeChatRunId = snapshot.activeChatRunId
  if (snapshot.turnStartTs !== undefined) {
    rt.turnStartTs = snapshot.turnStartTs
  } else if (!isTurnBusy(rt)) {
    rt.turnStartTs = null
  }
  notify({ immediate: true })
  notifySession(sk, { immediate: true })
}

export function mountSessionRuntime(
  sessionKey: string,
  targets: {
    streamRef: { current: StreamState }
    seenRunIdsRef: { current: Set<string> }
    activeChatRunIdRef: { current: string | null }
    turnStartTsRef?: { current: number | null }
    liveTurnTimingSessionKeyRef?: { current: string }
  },
): SessionRuntime {
  const rt = getSessionRuntime(sessionKey)
  targets.streamRef.current = rt.stream
  targets.seenRunIdsRef.current = new Set(rt.seenRunIds)
  targets.activeChatRunIdRef.current = rt.activeChatRunId
  const timingActive = isTurnBusy(rt) && rt.turnStartTs != null
  if (targets.turnStartTsRef) {
    targets.turnStartTsRef.current = timingActive ? rt.turnStartTs : null
  }
  if (targets.liveTurnTimingSessionKeyRef) {
    targets.liveTurnTimingSessionKeyRef.current = timingActive ? sessionKey : ''
  }
  return rt
}

export function rowsBaseForSend(rtRows: DisplayRow[], visibleRows: DisplayRow[]): DisplayRow[] {
  if (!rtRows.length) return [...visibleRows]
  if (!visibleRows.length) return [...rtRows]
  if (visibleRows.length > rtRows.length) return [...visibleRows]
  return [...rtRows]
}

export function hydrateSessionRuntimeRowsIfIdle(sessionKey: string, rows: DisplayRow[]): void {
  const sk = String(sessionKey || '').trim()
  if (!sk || !rows.length) return
  const rt = getSessionRuntime(sk)
  if (isSessionRuntimeLive(rt)) return
  if (rt.rows.length >= rows.length) return
  rt.rows = [...rows]
  notifySession(sk)
}

/** Idle / committed transcript snapshot for instant session reopen (no network). */
export function peekIdleSessionRuntimeRows(sessionKey: string): DisplayRow[] | null {
  const sk = String(sessionKey || '').trim()
  if (!sk) return null
  const rt = getSessionRuntime(sk)
  if (isSessionRuntimeLive(rt)) return null
  if (!Array.isArray(rt.rows) || !rt.rows.length) return null
  return rt.rows
}

export function updateSessionRuntimeRows(
  sessionKey: string,
  updater: (rows: DisplayRow[]) => DisplayRow[],
): DisplayRow[] {
  const sk = String(sessionKey || '').trim()
  const rt = getSessionRuntime(sk)
  rt.rows = updater([...rt.rows])
  notifySession(sk)
  return rt.rows
}

/** @deprecated Use dispatchSessionTurnEvent */
export function markSessionSending(sessionKey: string, sending: boolean): void {
  if (sending) {
    dispatchSessionTurnEvent(sessionKey, { type: 'SEND_STARTED' })
  } else {
    dispatchSessionTurnEvent(sessionKey, { type: 'TURN_IDLE' })
  }
}

/** @deprecated Use dispatchSessionTurnEvent */
export function markSessionAttachState(
  sessionKey: string,
  patch: Partial<{
    attachState: SessionAttachState
    attachedThreadId: string | null
    activeChatRunId: string | null
    lastEventAt: number | null
    lastVisibleTextPreview: string | null
    lastToolPreview: string | null
    resumeCatchupReplay: boolean
    streamWireSource: StreamWireSource
  }>,
): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  const rt = getSessionRuntime(sk)
  if (patch.attachState !== undefined) {
    switch (patch.attachState) {
      case 'attaching':
        dispatchSessionTurnEvent(sk, {
          type: 'REATTACH_STARTED',
          runId: String(patch.activeChatRunId || rt.activeChatRunId || ''),
          threadId: patch.attachedThreadId ?? rt.attachedThreadId,
        })
        break
      case 'attached':
        dispatchSessionTurnEvent(sk, {
          type: 'REATTACH_LIVE',
          runId: String(patch.activeChatRunId || rt.activeChatRunId || ''),
          threadId: patch.attachedThreadId ?? rt.attachedThreadId,
        })
        break
      case 'detached':
        dispatchSessionTurnEvent(sk, {
          type: 'REATTACH_DEGRADED',
          runId: patch.activeChatRunId ?? rt.activeChatRunId,
          threadId: patch.attachedThreadId ?? rt.attachedThreadId,
        })
        break
      case 'error':
        dispatchSessionTurnEvent(sk, {
          type: 'REATTACH_FAILED',
          threadId: patch.attachedThreadId ?? rt.attachedThreadId,
        })
        break
      case 'idle':
      default:
        dispatchSessionTurnEvent(sk, { type: 'TURN_IDLE' })
        break
    }
  }
  if (patch.attachedThreadId !== undefined) rt.attachedThreadId = patch.attachedThreadId
  if (patch.activeChatRunId !== undefined) rt.activeChatRunId = patch.activeChatRunId
  if (patch.lastEventAt !== undefined) rt.lastEventAt = patch.lastEventAt
  if (patch.lastVisibleTextPreview !== undefined) {
    // @ts-ignore
    rt.lastVisibleTextPreview = patch.lastVisibleTextPreview
  }
  // @ts-ignore
  if (patch.lastToolPreview !== undefined) rt.lastToolPreview = patch.lastToolPreview
  if (patch.resumeCatchupReplay !== undefined) {
    dispatchSessionTurnEvent(sk, { type: 'RESUME_CATCHUP', active: patch.resumeCatchupReplay })
  }
  if (patch.streamWireSource !== undefined) {
    dispatchSessionTurnEvent(sk, { type: 'WIRE_SOURCE', source: patch.streamWireSource })
  }
  notifySession(sk)
}

export function markSessionStreamWireSource(sessionKey: string, source: StreamWireSource): void {
  dispatchSessionTurnEvent(sessionKey, { type: 'WIRE_SOURCE', source })
}

export function noteSessionEvent(
  sessionKey: string,
  rt: SessionRuntime,
  patch: {
    at?: number | null
    textPreview?: string | null
    toolPreview?: string | null
    /** Skip subscriber notify (background SSE deltas). */
    silent?: boolean
  },
): void {
  const sk = String(sessionKey || '').trim()
  if (patch.at !== undefined) rt.lastEventAt = patch.at
  if (patch.textPreview !== undefined && patch.textPreview !== null) {
    rt.lastVisibleTextPreview = String(patch.textPreview)
  }
  if (patch.toolPreview !== undefined && patch.toolPreview !== null) {
    rt.lastToolPreview = String(patch.toolPreview)
  }
  if (sk && !patch.silent) notifySession(sk)
}

export function setSessionActivity(
  sessionKey: string,
  kind: string,
  detail: string,
): void {
  dispatchSessionTurnEvent(sessionKey, { type: 'ACTIVITY', kind, detail })
}

export function seenRunIdSet(rt: SessionRuntime): Set<string> {
  return new Set(rt.seenRunIds)
}

export function rtHasSeenRun(rt: SessionRuntime, runId: string | null | undefined): boolean {
  const id = String(runId || '').trim()
  if (!id) return false
  return rt.seenRunIds.includes(id)
}

/** 记录已处理 run；同轮 client UUID + wire run 双 id 一并记入，避免重复 final。 */
export function rtAddSeenRun(rt: SessionRuntime, runId: string | null | undefined): void {
  const id = String(runId || '').trim()
  if (!id) return
  const next = new Set(rt.seenRunIds)
  next.add(id)
  const active = String(rt.activeChatRunId || '').trim()
  if (active) next.add(active)
  rt.seenRunIds = [...next]
}

export function rtIsStoppedRun(rt: SessionRuntime, runId: string | null | undefined): boolean {
  const id = String(runId || '').trim()
  return id ? rt.stoppedRunIds.includes(id) : false
}

export function rtAddStoppedRun(rt: SessionRuntime, runId: string | null | undefined): void {
  const id = String(runId || '').trim()
  if (!id || rt.stoppedRunIds.includes(id)) return
  rt.stoppedRunIds = [...rt.stoppedRunIds, id].slice(-32)
}

export function rtAddStaleToolCallIds(rt: SessionRuntime, ids: Iterable<string>): void {
  const set = new Set(rt.staleToolCallIds)
  for (const raw of ids) {
    const id = String(raw || '').trim()
    if (id) set.add(id)
  }
  rt.staleToolCallIds = [...set].slice(-128)
}

export function collectToolCallIdsFromDisplayRow(row: DisplayRow): string[] {
  const ids: string[] = []
  for (const t of row.tools || []) {
    const o = t as Record<string, unknown>
    const id = String(o.id || o.tool_call_id || '').trim()
    if (id) ids.push(id)
  }
  return ids
}

const STOP_SEALED_SYSTEM_TEXT = '生成已停止'
export const DEGRADED_SNAPSHOT_SYSTEM_TEXT = '连接已断开，以下为上次进度'
const STOP_SEALED_SYSTEM_TEXTS = new Set([STOP_SEALED_SYSTEM_TEXT, DEGRADED_SNAPSHOT_SYSTEM_TEXT])

export function rowsAlreadyStopSealedForTurn(rows: DisplayRow[]): boolean {
  let lastUserIdx = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role === 'user') {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx < 0) return false
  return rows
    .slice(lastUserIdx + 1)
    .some((r) => r.role === 'system' && STOP_SEALED_SYSTEM_TEXTS.has(String(r.text || '').trim()))
}

export function collectStaleToolIdsFromPriorTurn(rows: DisplayRow[]): string[] {
  const ids = new Set<string>()
  let usersSeen = 0
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row.role === 'user') {
      usersSeen++
      if (usersSeen >= 2) break
      continue
    }
    if (usersSeen >= 1 && row.role === 'assistant') {
      for (const id of collectToolCallIdsFromDisplayRow(row)) ids.add(id)
    }
  }
  return [...ids]
}

export function resetRuntimeStream(
  rt: SessionRuntime,
  activeStreamRef?: { current: StreamState },
): void {
  rt.stream = emptyStream()
  if (activeStreamRef) activeStreamRef.current = rt.stream
}

export function resetSessionLiveStreamDisplay(
  sessionKey: string,
  activeStreamRef?: { current: StreamState },
): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  const rt = getSessionRuntime(sk)
  resetRuntimeStream(rt, activeStreamRef)
  rt.lastVisibleTextPreview = ''
  rt.lastToolPreview = ''
  notifySession(sk, { immediate: true })
  notify({ immediate: true })
}

export function markSessionResumeCatchupReplay(sessionKey: string, active: boolean): void {
  dispatchSessionTurnEvent(sessionKey, { type: 'RESUME_CATCHUP', active })
}

export function replaceSessionRuntimeRowsFromHistory(sessionKey: string, rows: DisplayRow[]): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  const rt = getSessionRuntime(sk)
  rt.rows = [...rows]
  notifySession(sk, { immediate: true })
  notify({ immediate: true })
}