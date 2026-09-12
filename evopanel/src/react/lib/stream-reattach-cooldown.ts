/** Per-session cooldown after stream-resume degrades / user stop — avoids API spam loops. */

const DEFAULT_MS = 45_000
const SESSION_RECOVERY_COOLDOWN_MS = 90_000
/** Wildcard runId: block all recovery / reattach probes for the session. */
export const SESSION_RECOVERY_COOLDOWN_RUN_ID = '*'

const cooldownBySession = new Map<string, { until: number; runId: string }>()

export function markStreamReattachCooldown(
  sessionKey: string,
  runId: string,
  ms: number = DEFAULT_MS,
): void {
  const sk = String(sessionKey || '').trim()
  const rid = String(runId || '').trim()
  if (!sk || !rid || ms <= 0) return
  cooldownBySession.set(sk, { until: Date.now() + ms, runId: rid })
}

/** After user stop or forced idle: pause runtime-status / reattach polling for the whole session. */
export function markSessionRecoveryCooldown(
  sessionKey: string,
  ms: number = SESSION_RECOVERY_COOLDOWN_MS,
): void {
  markStreamReattachCooldown(sessionKey, SESSION_RECOVERY_COOLDOWN_RUN_ID, ms)
}

export function isSessionRecoveryCooldownActive(sessionKey: string): boolean {
  return isStreamReattachCooldownActive(sessionKey, SESSION_RECOVERY_COOLDOWN_RUN_ID)
}

export function isStreamReattachCooldownActive(
  sessionKey: string,
  runId?: string | null,
): boolean {
  const sk = String(sessionKey || '').trim()
  if (!sk) return false
  const entry = cooldownBySession.get(sk)
  if (!entry || Date.now() >= entry.until) {
    if (entry) cooldownBySession.delete(sk)
    return false
  }
  if (entry.runId === SESSION_RECOVERY_COOLDOWN_RUN_ID) return true
  const wanted = String(runId || '').trim()
  if (wanted && entry.runId && wanted !== entry.runId) return false
  return true
}

export function clearStreamReattachCooldown(sessionKey: string): void {
  const sk = String(sessionKey || '').trim()
  if (sk) cooldownBySession.delete(sk)
}
