/**
 * Per-session live stream snapshot store (ZCode v4-aligned).
 *
 * Replaces the old ``live-stream-store`` + ``stream-display-tick`` + overlay
 * patchwork with a single atomic store:
 *
 *  - snapshot → 整体替换，绝不 merge；
 *  - delta frame 应用规则：``frame.fromSeq === snapshot.seq`` 才能 apply，
 *    否则推 recovery；一次性 commit 整块新 snapshot（不会在期间有"半新半旧"）。
 *  - status state machine: ``connecting | live | error | closed``；
 *  - 订阅通知：组件通过 ``useSyncExternalStore(subscribe, getState)`` 拉取；
 *    ``subscribe`` 返回 ``getState`` 的稳定引用，外部不缓存中间对象。
 *
 * Writers:
 *  - ``commitStreamSnapshot``: 整块替换。引用相等短路；
 *  - ``commitStreamFrame``: 应用一个 fromSeq-toSeq 帧；不衔接时拒绝、
 *    自动推 recovery（请求方用 ``subscribeRecoverySignal`` 监听）。
 *  - ``setStoreStatus``: 状态机的内部循环（runtime 换代 / 手点重连）。
 *  - ``closeStore``: 终结该 sk store。
 */

import { useSyncExternalStore } from 'react'
import { noteLiveStreamPublish } from './client-perf.js'

export type StreamSnapshotStoreStatus = 'connecting' | 'live' | 'error' | 'closed'

export interface StreamSnapshotStoreState<T = unknown> {
  status: StreamSnapshotStoreStatus
  snapshot: T | null
  /** 当前帧右端点；下一帧必须 fromSeq === seq，否则断档。 */
  seq: number
  /** 最近一次 error（status === 'error' 时展示）。 */
  lastError: string | null
}

type Entry = {
  state: StreamSnapshotStoreState<unknown>
  listeners: Set<() => void>
  /**
   * 等待中的 recovery：单条 frame 因 fromSeq 不对齐被拒绝时，
   * 触发 ``commitStreamFrame`` 返回 ``recoveryTriggered=true``，并递增
   * ``recoveryRevision``；订阅 ``subscribeRecoverySignal`` 的上游会拿到通知，
   * 由上游决定是否重订阅 / 整体重拉。
   */
  recoveryRevision: number
  recoveryListeners: Set<() => void>
}

const INITIAL_STATE: StreamSnapshotStoreState = {
  status: 'connecting',
  snapshot: null,
  seq: 0,
  lastError: null,
}

const bySession = new Map<string, Entry>()

function entryFor(sk: string): Entry {
  let e = bySession.get(sk)
  if (!e) {
    e = {
      state: { ...INITIAL_STATE, snapshot: null },
      listeners: new Set(),
      recoveryRevision: 0,
      recoveryListeners: new Set(),
    }
    bySession.set(sk, e)
  }
  return e
}

function noteCommit(e: Entry): void {
  if (e.listeners.size === 0) return
  for (const cb of e.listeners) cb()
}

/**
 * 整块快照替换。引用相等短路：commit 同一引用 → 静默（同 ChatApp
 * "streamRef.current 没变就跳过 scheduleBump"）。seq 必须 ≥ 当前；否则
 * 视为迟到帧，前端丢弃（避免 race 时序倒退覆盖新鲜投影）。
 *
 * 同一引用多次提交时，使用 ``opts.seq`` 提供递增的 seq 让 seq 前进，
 * 触发下游订阅者的 ``useStreamSnapshotSeq`` 重算。这正是解决
 * ``streamRef.current`` 内部 mutation 不能让 React useMemo 重算的关键：
 * 在 ChatApp 的每一次 live/structural bump 处递增一次 seq。
 */
export function commitStreamSnapshot<T>(
  sessionKey: string,
  snap: T,
  opts?: { seq?: number },
): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  const e = entryFor(sk)
  const nextSeq = typeof opts?.seq === 'number' ? opts.seq : e.state.seq + 1
  if (nextSeq < e.state.seq) return
  if (e.state.snapshot === snap && e.state.seq === nextSeq && e.state.status === 'live') return
  e.state = {
    ...e.state,
    status: 'live',
    snapshot: snap,
    seq: nextSeq,
    lastError: null,
  }
  noteLiveStreamPublish()
  noteCommit(e)
}

/**
 * 应用一个 fromSeq→toSeq 帧：断档（fromSeq !== state.seq）→ 拒绝 + 推 recovery；
 * 衔接 → 推进 seq + 整体替换 snapshot（不会原地 merge）。若上游 reducer 已在
 * 上一次 commit 中给出整 snapshot，可直接用 ``commitStreamSnapshot``；此接口
 * 留给 ChatApp 的 reducer 把 frame 形式（delta-only）原子化整块后再 commit。
 */
export function commitStreamFrame<T>(
  sessionKey: string,
  frame: { fromSeq: number; toSeq: number; snapshot: T },
): { accepted: boolean; recoveryTriggered: boolean } {
  const sk = String(sessionKey || '').trim()
  if (!sk) return { accepted: false, recoveryTriggered: false }
  const e = entryFor(sk)
  if (frame.fromSeq !== e.state.seq) {
    e.recoveryRevision += 1
    for (const cb of e.recoveryListeners) cb()
    return { accepted: false, recoveryTriggered: true }
  }
  e.state = {
    ...e.state,
    status: 'live',
    snapshot: frame.snapshot,
    seq: frame.toSeq,
    lastError: null,
  }
  noteCommit(e)
  return { accepted: true, recoveryTriggered: false }
}

export function setStoreStatus(
  sessionKey: string,
  status: StreamSnapshotStoreStatus,
  lastError?: string | null,
): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  const e = entryFor(sk)
  const cur = e.state
  const nextErr = status === 'error' ? lastError ?? cur.lastError ?? 'unknown error' : null
  if (cur.status === status && cur.lastError === nextErr) return
  e.state = {
    ...cur,
    status,
    lastError: nextErr,
  }
  noteCommit(e)
}

export function getStreamSnapshot<T>(sessionKey: string): StreamSnapshotStoreState<T> {
  const sk = String(sessionKey || '').trim()
  if (!sk) return { ...INITIAL_STATE, snapshot: null } as StreamSnapshotStoreState<T>
  return entryFor(sk).state as StreamSnapshotStoreState<T>
}

export function subscribeStreamSnapshot(
  sessionKey: string,
  cb: () => void,
): () => void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return () => {}
  const ent = entryFor(sk)
  ent.listeners.add(cb)
  return () => {
    ent.listeners.delete(cb)
  }
}

export function subscribeRecoverySignal(
  sessionKey: string,
  cb: () => void,
): () => void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return () => {}
  const ent = entryFor(sk)
  ent.recoveryListeners.add(cb)
  return () => {
    ent.recoveryListeners.delete(cb)
  }
}

export function readRecoveryRevision(sessionKey: string): number {
  return entryFor(String(sessionKey || '').trim()).recoveryRevision
}

export function deleteStreamSnapshot(sessionKey: string): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  bySession.delete(sk)
}

export function pruneStreamSnapshots(keepKeys: Iterable<string>): number {
  const keep = new Set<string>()
  for (const raw of keepKeys) {
    const k = String(raw || '').trim()
    if (k) keep.add(k)
  }
  let removed = 0
  for (const sk of bySession.keys()) {
    if (keep.has(sk)) continue
    bySession.delete(sk)
    removed += 1
  }
  return removed
}

export function resetStreamSnapshotStoreForTests(): void {
  bySession.clear()
}

/**
 * React 端订阅：当 store 的 seq 变化时让组件重新求值（配合 mutable streamRef
 * 使用，确保 ``MessageVirtualList`` 的 useMemo deps 看到 seq 增长）。
 *
 * 内部直接调 ``useSyncExternalStore``，所以 sk 必须在 render 期就确定，
 * 不能条件分支；上层 `sessionKeyForSend` 即已承担这一点。
 */
export function useStreamSnapshotSeq(sessionKey: string): number {
  const sk = String(sessionKey || '').trim()
  return useSyncExternalStore(
    (cb) => subscribeStreamSnapshot(sk, cb),
    () => getStreamSnapshot(sk).seq,
    () => getStreamSnapshot(sk).seq,
  )
}
