/**
 * 目标模式运行态 — 与 session-execution 读模型统一。
 */

let epoch = 0
const goalRunning = new Set<string>()
const listeners = new Set<() => void>()

function bump(): void {
  epoch += 1
  for (const fn of listeners) {
    try {
      fn()
    } catch {
      /* ignore */
    }
  }
}

export function getSessionGoalStateEpoch(): number {
  return epoch
}

export function subscribeSessionGoalState(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function markSessionGoalRunning(sessionKey: string, running: boolean): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  const has = goalRunning.has(sk)
  if (running && has) return
  if (!running && !has) return
  if (running) goalRunning.add(sk)
  else goalRunning.delete(sk)
  bump()
}

export function isSessionGoalRunning(sessionKey: string | null | undefined): boolean {
  const sk = String(sessionKey || '').trim()
  return sk ? goalRunning.has(sk) : false
}

export function collectGoalRunningSessionKeys(): ReadonlySet<string> {
  return goalRunning
}

export function clearSessionGoalRunning(sessionKey: string): void {
  markSessionGoalRunning(sessionKey, false)
}
