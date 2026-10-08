/**
 * TEST-ONLY compatibility shim for the legacy ``live-stream-store``.
 *
 * After the streaming refactor, the snapshot store lives in
 * ``stream-snapshot-store.ts`` and the live-text overlay path was retired.
 * This shim preserves the per-session publish/subscribe/clear API used by
 * the historical tests in ``tests/live-stream-path.test.js`` so they still
 * document the old behavior without dragging the production overlay into the
 * new architecture.
 *
 * NOT used by runtime components.
 */

type Entry = {
  snap: { text: string; streaming: boolean; epoch: number }
  listeners: Set<() => void>
}

const bySession = new Map<string, Entry>()
let globalEpoch = 1

function entryFor(sk: string): Entry {
  let e = bySession.get(sk)
  if (!e) {
    e = { snap: { text: '', streaming: false, epoch: 0 }, listeners: new Set() }
    bySession.set(sk, e)
  }
  return e
}

export function getLiveStreamSnapshot(sessionKey: string): { text: string; streaming: boolean; epoch: number } {
  const sk = String(sessionKey || '').trim()
  if (!sk) return { text: '', streaming: false, epoch: 0 }
  return entryFor(sk).snap
}

export function subscribeLiveStream(sessionKey: string, cb: () => void): () => void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return () => {}
  const e = entryFor(sk)
  e.listeners.add(cb)
  return () => {
    e.listeners.delete(cb)
  }
}

export function publishLiveStream(
  sessionKey: string,
  payload: { text?: string; reasoning?: string; streaming?: boolean },
): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  const e = entryFor(sk)
  const text = String(payload?.text ?? '')
  // streaming 缺省/显式 false 视为"未在 streaming"；不更新 streaming 标志。
  // 这样 `publishLiveStream(sk, { text: 'hi' })` 在 `publishLiveStream(sk, { text: 'hi', streaming: true })` 之后
  // 不会再触发通知，与历史 live-stream-store 行为一致。
  if (text) {
    if (e.snap.text === text) {
      // body 没变：不通知。streaming 字段始终为 true（一旦进入 streaming 就一直 true）。
      return
    }
    e.snap = { text, streaming: true, epoch: ++globalEpoch }
  } else {
    // payload 没 text：保留旧 text，仅 streaming 状态变化 → 同步为最新值
    const streaming = payload?.streaming === true
    if (e.snap.streaming === streaming) return
    e.snap = { text: e.snap.text, streaming, epoch: ++globalEpoch }
  }
  for (const cb of e.listeners) cb()
}

export function clearLiveStream(sessionKey: string): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  const e = entryFor(sk)
  if (!e.snap.text && !e.snap.streaming) return
  e.snap = { text: '', streaming: false, epoch: ++globalEpoch }
  for (const cb of e.listeners) cb()
}

export function deleteLiveStream(sessionKey: string): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  bySession.delete(sk)
}

export function pruneLiveStreams(keepKeys: Iterable<string>): void {
  const keep = new Set<string>()
  for (const raw of keepKeys) {
    const sk = String(raw || '').trim()
    if (sk) keep.add(sk)
  }
  for (const sk of [...bySession.keys()]) if (!keep.has(sk)) bySession.delete(sk)
}

export function resetLiveStreamStoreForTests(): void {
  bySession.clear()
  globalEpoch = 1
}
