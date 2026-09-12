import type { TokenTotals } from '../chat-types.js'

function sumCache(
  older: TokenTotals | null | undefined,
  newer: TokenTotals | null | undefined,
  key: 'cacheRead' | 'cacheCreation' | 'cacheMiss',
): number | undefined {
  const total = (older?.[key] ?? 0) + (newer?.[key] ?? 0)
  return total > 0 ? total : undefined
}

export function mergeTokenTotals(
  older: TokenTotals | null,
  newer: TokenTotals | null,
): TokenTotals | null {
  if (!older && !newer) return null
  const merged: TokenTotals = {
    input: (older?.input ?? 0) + (newer?.input ?? 0),
    output: (older?.output ?? 0) + (newer?.output ?? 0),
    total: (older?.total ?? 0) + (newer?.total ?? 0),
  }
  const cacheRead = sumCache(older, newer, 'cacheRead')
  const cacheCreation = sumCache(older, newer, 'cacheCreation')
  const cacheMiss = sumCache(older, newer, 'cacheMiss')
  if (cacheRead !== undefined) merged.cacheRead = cacheRead
  if (cacheCreation !== undefined) merged.cacheCreation = cacheCreation
  if (cacheMiss !== undefined) merged.cacheMiss = cacheMiss
  return merged
}
