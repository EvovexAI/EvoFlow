const recentlyStreamed = new Map<string, number>()
const TTL = 10_000

export function markRecentlyStreamed(runId: string): void {
  if (runId) recentlyStreamed.set(runId, Date.now())
}

export function isRecentlyStreamed(runId?: string): boolean {
  if (!runId) return false
  const ts = recentlyStreamed.get(runId)
  if (!ts) return false
  if (Date.now() - ts > TTL) {
    recentlyStreamed.delete(runId)
    return false
  }
  return true
}

export function clearRecentlyStreamed(): void {
  recentlyStreamed.clear()
}