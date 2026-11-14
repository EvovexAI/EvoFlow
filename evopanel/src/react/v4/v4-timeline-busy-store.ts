/**
 * V4 时间线「还有活」→ Composer / 列表 busy。
 * sse_final 可能早关 selectedTurnBusy，但 snapshot 仍有 streaming / running 工具；
 * Bridge 每帧同步到这里，ChatComposer 用 useSyncExternalStore 并进停止键。
 */
const busyBySession = new Map<string, boolean>()
const listeners = new Set<() => void>()
let epoch = 0

function emit() {
  epoch += 1
  for (const l of listeners) l()
}

export function setV4TimelineBusy(sessionKey: string | null | undefined, busy: boolean): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  const prev = busyBySession.get(sk) === true
  const next = !!busy
  if (prev === next) return
  if (next) busyBySession.set(sk, true)
  else busyBySession.delete(sk)
  emit()
}

export function getV4TimelineBusy(sessionKey: string | null | undefined): boolean {
  const sk = String(sessionKey || '').trim()
  if (!sk) return false
  return busyBySession.get(sk) === true
}

export function subscribeV4TimelineBusy(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getV4TimelineBusyEpoch(): number {
  return epoch
}
