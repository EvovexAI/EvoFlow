/**
 * Per-session context-window usage hydrate from session list / selected row.
 * Extracted from ChatApp.tsx (P11). Live SSE merges stay in ChatApp via setContextUsageBySession.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ChatSessionRow } from '../chat-types.js'
import {
  mergeContextUsageSnapshots,
  parseContextUsageFromSessionContext,
  type ContextUsageSnapshot,
} from '../lib/context-usage.js'

export function useContextUsageBySession(opts: {
  selectedSessionKey: string
  sessions: ChatSessionRow[]
}) {
  const { selectedSessionKey, sessions } = opts

  const [contextUsageBySession, setContextUsageBySession] = useState<
    Record<string, ContextUsageSnapshot>
  >({})

  const hydrateContextUsageFromSessions = useCallback((rows: ChatSessionRow[]) => {
    if (!Array.isArray(rows) || rows.length === 0) return
    setContextUsageBySession((prev) => {
      let changed = false
      const next = { ...prev }
      for (const row of rows) {
        const sk = String(row.sessionKey || '').trim()
        if (!sk) continue
        const snap = parseContextUsageFromSessionContext(row.context)
        if (!snap) continue
        const merged = mergeContextUsageSnapshots(prev[sk], snap)
        if (merged !== prev[sk]) {
          next[sk] = merged
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [])

  useEffect(() => {
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return
    const row = sessions.find((s) => String(s.sessionKey || '').trim() === sk)
    const snap = parseContextUsageFromSessionContext(row?.context)
    if (!snap) return
    queueMicrotask(() => {
      setContextUsageBySession((prev) => {
        const merged = mergeContextUsageSnapshots(prev[sk], snap)
        if (merged === prev[sk]) return prev
        return { ...prev, [sk]: merged }
      })
    })
  }, [selectedSessionKey, sessions])

  return {
    contextUsageBySession,
    setContextUsageBySession,
    hydrateContextUsageFromSessions,
  }
}
