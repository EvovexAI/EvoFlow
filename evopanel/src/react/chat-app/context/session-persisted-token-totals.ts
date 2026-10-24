/**
 * Build TokenTotals from the selected session row's persisted counters.
 * Extracted from ChatApp.tsx (P40).
 */
import type { TokenTotals } from '../../chat-types.js'

export type SessionTokenRow = {
  sessionKey?: string
  totalTokens?: number | null
  inputTokens?: number | null
  outputTokens?: number | null
  cacheReadTokens?: number | null
  cacheCreationTokens?: number | null
  cacheMissTokens?: number | null
}

export function sessionPersistedTokenTotals(
  selectedSessionKey: string,
  sessions: SessionTokenRow[],
): TokenTotals | null {
  const sk = String(selectedSessionKey || '').trim()
  if (!sk) return null
  const row = sessions.find((s) => String(s.sessionKey || '') === sk)
  if (!row) return null
  const total = Number(row.totalTokens) || 0
  if (total <= 0) return null
  return {
    input: Number(row.inputTokens) || 0,
    output: Number(row.outputTokens) || 0,
    total,
    ...(Number(row.cacheReadTokens) > 0 ? { cacheRead: Number(row.cacheReadTokens) } : {}),
    ...(Number(row.cacheCreationTokens) > 0 ? { cacheCreation: Number(row.cacheCreationTokens) } : {}),
    ...(Number(row.cacheMissTokens) > 0 ? { cacheMiss: Number(row.cacheMissTokens) } : {}),
  }
}
