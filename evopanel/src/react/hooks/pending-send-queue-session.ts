/**
 * Pending-send queue helpers that are session-aware (background drain safe).
 */

export type PendingSendQueueItem = { id: string; text: string }

/** Collect session keys that still have local queue / steer / inject work. */
export function collectPendingDrainCandidateKeys(input: {
  queuesBySession: Map<string, PendingSendQueueItem[]>
  midTurnInjects: Array<{ sessionKey?: string }>
  pendingSteers: Array<{ sessionKey?: string }>
}): string[] {
  const out = new Set<string>()
  for (const [sk, q] of input.queuesBySession) {
    if (sk && Array.isArray(q) && q.length > 0) out.add(sk)
  }
  for (const x of input.midTurnInjects || []) {
    const sk = String(x?.sessionKey || '').trim()
    if (sk) out.add(sk)
  }
  for (const s of input.pendingSteers || []) {
    const sk = String(s?.sessionKey || '').trim()
    if (sk) out.add(sk)
  }
  return [...out]
}

/**
 * Patch one session's queue in the bucket map.
 * Returns the next list; caller decides whether to mirror into focused React state.
 */
export function patchPendingSendQueueForSession(
  queuesBySession: Map<string, PendingSendQueueItem[]>,
  sessionKey: string,
  updater: (prev: PendingSendQueueItem[]) => PendingSendQueueItem[],
  focusedFallback: PendingSendQueueItem[] = [],
): PendingSendQueueItem[] {
  const sk = String(sessionKey || '').trim()
  if (!sk) return focusedFallback
  const prev = queuesBySession.get(sk) || focusedFallback
  const next = updater(prev)
  queuesBySession.set(sk, next)
  return next
}
