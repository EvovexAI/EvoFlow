/** Tracks in-flight pin/unpin until GET /api/chat/sessions reflects the change. */
const PENDING_TTL_MS = 15_000

const pending = new Map<string, { pinned: boolean; at: number }>()

function pruneExpired(now = Date.now()): void {
  for (const [key, entry] of pending) {
    if (now - entry.at > PENDING_TTL_MS) pending.delete(key)
  }
}

export function markSessionPinPending(sessionKey: string, pinned: boolean): void {
  const key = String(sessionKey || '').trim()
  if (!key) return
  pending.set(key, { pinned: !!pinned, at: Date.now() })
}

export function clearSessionPinPending(sessionKey: string): void {
  pending.delete(String(sessionKey || '').trim())
}

/** Merge API pin state with optimistic / in-flight pin mutations. */
export function resolveMergedSessionPin(sessionKey: string, apiPinned: boolean): boolean {
  pruneExpired()
  const key = String(sessionKey || '').trim()
  const entry = key ? pending.get(key) : undefined
  const api = !!apiPinned

  if (!entry) return api

  if (api === entry.pinned) {
    pending.delete(key)
    return api
  }
  return entry.pinned
}
