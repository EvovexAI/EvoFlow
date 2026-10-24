/**
 * Merge persisted session token totals with live turn tokens for the header.
 * Extracted from ChatApp.tsx (P34).
 */
import type { TokenTotals } from '../../chat-types.js'

export function mergeHeaderTokenTotals(
  tokenTotals: TokenTotals | null | undefined,
  sessionPersistedTokenTotals: TokenTotals | null | undefined,
  liveTurnTokens: TokenTotals | null | undefined,
): TokenTotals | null {
  const base = tokenTotals ?? sessionPersistedTokenTotals ?? null
  const live = liveTurnTokens
  if (!live) return base
  const mergedBase = base ?? { input: 0, output: 0, total: 0 }
  const merged: TokenTotals = {
    input: mergedBase.input + live.input,
    output: mergedBase.output + live.output,
    total: mergedBase.total + live.total,
  }
  const cacheRead = (mergedBase.cacheRead ?? 0) + (live.cacheRead ?? 0)
  const cacheCreation = (mergedBase.cacheCreation ?? 0) + (live.cacheCreation ?? 0)
  const cacheMiss = (mergedBase.cacheMiss ?? 0) + (live.cacheMiss ?? 0)
  if (cacheRead > 0) merged.cacheRead = cacheRead
  if (cacheCreation > 0) merged.cacheCreation = cacheCreation
  if (cacheMiss > 0) merged.cacheMiss = cacheMiss
  return merged.total > 0 ? merged : base
}
