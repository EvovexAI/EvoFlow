import { buildHistoryViewFromRaw } from '../lib/chatHistoryView.js'
import {
  fetchSessionHistoryMessages,
  HISTORY_OPEN_PAGE_SIZE,
} from '../hooks/fetchSessionHistory.js'
import {
  getSessionRuntime,
  isSessionRuntimeLive,
  replaceSessionRuntimeRowsFromHistory,
} from './session-runtime-store.js'

const inflight = new Map<string, Promise<void>>()
const warmedAt = new Map<string, number>()
const WARM_TTL_MS = 45_000
const WARM_MAP_MAX = 80

function pruneWarmedAt(now = Date.now()): void {
  for (const [sk, at] of warmedAt) {
    if (now - at >= WARM_TTL_MS) warmedAt.delete(sk)
  }
  if (warmedAt.size <= WARM_MAP_MAX) return
  const ordered = [...warmedAt.entries()].sort((a, b) => a[1] - b[1])
  const drop = warmedAt.size - WARM_MAP_MAX
  for (let i = 0; i < drop; i++) warmedAt.delete(ordered[i][0])
}

/** Await in-flight hover prefetch (if any). Resolves immediately when none. */
export function awaitSessionHistoryWarm(sessionKey: string): Promise<void> {
  const sk = String(sessionKey || '').trim()
  if (!sk) return Promise.resolve()
  return inflight.get(sk) || Promise.resolve()
}

/** Background prefetch: fill idle runtime.rows before user clicks a session. */
export function warmSessionHistoryPrefetch(sessionKey: string): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  pruneWarmedAt()
  const rt = getSessionRuntime(sk)
  if (isSessionRuntimeLive(rt)) return
  if (rt.rows.length > 0) return
  const last = warmedAt.get(sk) || 0
  if (Date.now() - last < WARM_TTL_MS) return
  if (inflight.has(sk)) return

  const job = (async () => {
    try {
      const { api } = await import('../../lib/tauri-api.js')
      const result = await fetchSessionHistoryMessages(
        (key, limit, opts) => api.chatHistory(key, limit, opts),
        sk,
        { limit: HISTORY_OPEN_PAGE_SIZE },
      )
      const built = buildHistoryViewFromRaw(result.messages)
      if (built.rows.length) {
        replaceSessionRuntimeRowsFromHistory(sk, built.rows)
        warmedAt.set(sk, Date.now())
      }
      // Empty / failed: do not stamp warmedAt — allow next hover to retry.
    } catch {
      /* best effort */
    }
  })().finally(() => {
    inflight.delete(sk)
  })
  inflight.set(sk, job)
}
