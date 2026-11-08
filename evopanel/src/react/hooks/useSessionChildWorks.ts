/**
 * Poll execution/state.childWorks for the selected chat session.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchSessionExecutionState,
  type SessionChildWorkItem,
} from '../lib/session-reattach.js'
import {
  logSessionChildWorksDiff,
  resetSessionChildWorkLog,
} from '../lib/session-child-work-log.js'

const ACTIVE = new Set(['pending', 'running'])
const POLL_MS = 3000

export function isChildWorkActive(status: string | null | undefined): boolean {
  return ACTIVE.has(String(status || '').trim().toLowerCase())
}

export function useSessionChildWorks(sessionKey: string | null | undefined) {
  const sk = String(sessionKey || '').trim()
  const [works, setWorks] = useState<SessionChildWorkItem[]>([])
  const [openCount, setOpenCount] = useState(0)

  const refresh = useCallback(async () => {
    if (!sk) {
      setWorks([])
      setOpenCount(0)
      return
    }
    try {
      const st = await fetchSessionExecutionState(sk, { bypassCache: true })
      const list = Array.isArray(st?.childWorks) ? st!.childWorks! : []
      setWorks(list)
      const n =
        typeof st?.openChildWorkCount === 'number'
          ? st.openChildWorkCount
          : list.filter((w) => isChildWorkActive(w.status)).length
      setOpenCount(n)
      logSessionChildWorksDiff(sk, list)
    } catch {
      /* best-effort */
    }
  }, [sk])

  useEffect(() => {
    if (!sk) {
      setWorks([])
      setOpenCount(0)
      resetSessionChildWorkLog()
      return
    }
    resetSessionChildWorkLog(sk)
    let cancelled = false
    let timer = 0

    const tick = async () => {
      if (cancelled || (typeof document !== 'undefined' && document.hidden)) return
      await refresh()
    }

    void tick()
    timer = window.setInterval(() => {
      void tick()
    }, POLL_MS)

    const onVis = () => {
      if (!document.hidden) void tick()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [sk, refresh])

  const activeByKind = useMemo(() => {
    const map = new Map<string, SessionChildWorkItem[]>()
    for (const w of works) {
      if (!isChildWorkActive(w.status)) continue
      const kind = String(w.kind || '').trim() || 'unknown'
      const arr = map.get(kind) || []
      arr.push(w)
      map.set(kind, arr)
    }
    return map
  }, [works])

  return { works, openCount, activeByKind, refresh }
}
