import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ensureThreadTitles,
  getThreadTitle,
  mergeThreadTitles,
  threadDisplayLabel,
} from '../lib/thread-title-cache'

type ThreadTitleContextValue = {
  version: number
  getTitle: (threadId: string | null | undefined) => string | null
  displayLabel: (threadId: string | null | undefined) => string
  registerThreadIds: (threadIds: Iterable<string | null | undefined>) => void
}

const ThreadTitleContext = createContext<ThreadTitleContextValue | null>(null)

export function ThreadTitleProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0)

  const bump = useCallback(() => setVersion((v) => v + 1), [])

  useEffect(() => {
    void ensureThreadTitles().then(() => bump())
  }, [bump])

  const registerThreadIds = useCallback(
    (threadIds: Iterable<string | null | undefined>) => {
      void ensureThreadTitles(threadIds).then(() => bump())
    },
    [bump],
  )

  const value = useMemo<ThreadTitleContextValue>(
    () => ({
      version,
      getTitle: (threadId) => getThreadTitle(threadId),
      displayLabel: (threadId) => threadDisplayLabel(threadId),
      registerThreadIds,
    }),
    [registerThreadIds, version],
  )

  return <ThreadTitleContext.Provider value={value}>{children}</ThreadTitleContext.Provider>
}

export function useThreadTitles(): ThreadTitleContextValue {
  const ctx = useContext(ThreadTitleContext)
  if (!ctx) throw new Error('useThreadTitles must be used within ThreadTitleProvider')
  return ctx
}

/** Merge sidebar / agent-trace session rows into the shared obs title cache. */
export function syncThreadTitlesFromSessions(
  sessions: { threadId?: string; thread_id?: string; title?: string }[],
) {
  mergeThreadTitles(
    sessions.map((s) => [String(s.threadId || s.thread_id || ''), String(s.title || '')] as [string, string]),
  )
}
