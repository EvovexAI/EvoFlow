/**
 * Per-session live assistant text/reasoning snapshot.
 * Token updates notify only subscribers (MessageRow); they must not rebuild the row list.
 */

import { noteLiveStreamPublish } from './client-perf.js'

export type LiveStreamSnapshot = {
  sessionKey: string
  text: string
  reasoning: string
  streaming: boolean
  /** Monotonic publish counter for this session */
  epoch: number
}

const EMPTY: LiveStreamSnapshot = {
  sessionKey: '',
  text: '',
  reasoning: '',
  streaming: false,
  epoch: 0,
}

type Entry = {
  snap: LiveStreamSnapshot
  listeners: Set<() => void>
}

const bySession = new Map<string, Entry>()

function entryFor(sessionKey: string): Entry {
  let e = bySession.get(sessionKey)
  if (!e) {
    e = {
      snap: { ...EMPTY, sessionKey },
      listeners: new Set(),
    }
    bySession.set(sessionKey, e)
  }
  return e
}

export function getLiveStreamSnapshot(sessionKey: string | null | undefined): LiveStreamSnapshot {
  const sk = String(sessionKey || '').trim()
  if (!sk) return EMPTY
  return entryFor(sk).snap
}

export function subscribeLiveStream(
  sessionKey: string | null | undefined,
  onStoreChange: () => void,
): () => void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return () => {}
  const e = entryFor(sk)
  e.listeners.add(onStoreChange)
  return () => {
    e.listeners.delete(onStoreChange)
  }
}

export function publishLiveStream(
  sessionKey: string,
  patch: {
    text?: string
    reasoning?: string
    streaming?: boolean
  },
): LiveStreamSnapshot {
  const sk = String(sessionKey || '').trim()
  if (!sk) return EMPTY
  const e = entryFor(sk)
  const prev = e.snap
  const next: LiveStreamSnapshot = {
    sessionKey: sk,
    text: patch.text !== undefined ? String(patch.text || '') : prev.text,
    reasoning: patch.reasoning !== undefined ? String(patch.reasoning || '') : prev.reasoning,
    streaming: patch.streaming !== undefined ? !!patch.streaming : prev.streaming,
    epoch: prev.epoch + 1,
  }
  if (
    next.text === prev.text &&
    next.reasoning === prev.reasoning &&
    next.streaming === prev.streaming
  ) {
    return prev
  }
  e.snap = next
  noteLiveStreamPublish()
  if (e.listeners.size === 0) return next
  for (const cb of e.listeners) cb()
  return next
}

export function clearLiveStream(sessionKey: string | null | undefined): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  const e = bySession.get(sk)
  if (!e) return
  e.snap = { ...EMPTY, sessionKey: sk }
  for (const cb of e.listeners) cb()
}

/** Remove session entry entirely (delete session / prune). */
export function deleteLiveStream(sessionKey: string | null | undefined): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  const e = bySession.get(sk)
  if (!e) return
  bySession.delete(sk)
  if (e.listeners.size) {
    for (const cb of e.listeners) cb()
  }
}

/**
 * Drop live-stream entries for sessions not in ``keepKeys`` and with no listeners.
 * Busy streaming entries are kept even if missing from keepKeys.
 */
export function pruneLiveStreams(keepKeys: Iterable<string>): number {
  const keep = new Set<string>()
  for (const raw of keepKeys) {
    const sk = String(raw || '').trim()
    if (sk) keep.add(sk)
  }
  let removed = 0
  for (const [sk, e] of bySession) {
    if (keep.has(sk)) continue
    if (e.snap.streaming) continue
    if (e.listeners.size > 0) continue
    bySession.delete(sk)
    removed += 1
  }
  return removed
}

/** Test helper */
export function resetLiveStreamStoreForTests(): void {
  bySession.clear()
}
