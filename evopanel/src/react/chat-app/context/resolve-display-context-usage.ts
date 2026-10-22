/**
 * Resolve context-usage snapshot for the header meter (persisted + live + catalog window).
 * Extracted from ChatApp.tsx (P34).
 */
import {
  mergeContextUsageSnapshots,
  parseContextUsageFromSessionContext,
  type ContextUsageSnapshot,
} from '../../lib/context-usage.js'

export type ResolveDisplayContextUsageArgs = {
  selectedSessionKey: string
  contextUsageBySession: Record<string, ContextUsageSnapshot | undefined>
  sessions: Array<{ sessionKey?: string; context?: Record<string, unknown> | null }>
  modelCatalog: Array<{ name?: string; contextLength?: number | null }>
  effectiveModelName: string | null | undefined
}

export function resolveDisplayContextUsage(
  args: ResolveDisplayContextUsageArgs,
): ContextUsageSnapshot | null {
  const sk = String(args.selectedSessionKey || '').trim()
  if (!sk) return null
  const catalogWindow = args.modelCatalog.find((m) => m.name === args.effectiveModelName)?.contextLength
  const sessionRow = args.sessions.find((s) => String(s.sessionKey || '').trim() === sk)
  const persistedSnap = parseContextUsageFromSessionContext(sessionRow?.context)
  const liveSnap = args.contextUsageBySession[sk]
  const snap = liveSnap
    ? mergeContextUsageSnapshots(persistedSnap ?? undefined, liveSnap)
    : persistedSnap
  // 无后端/持久化快照时不合成占位数据，避免工作台空圆环
  if (!snap || snap.usedTokens <= 0) return null
  if (catalogWindow && catalogWindow > 0 && catalogWindow !== snap.windowTokens) {
    const pct = (snap.usedTokens / catalogWindow) * 100
    return {
      ...snap,
      windowTokens: catalogWindow,
      pct: Math.round(pct * 10) / 10,
    }
  }
  return snap
}
