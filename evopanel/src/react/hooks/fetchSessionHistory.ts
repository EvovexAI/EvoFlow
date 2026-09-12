/** Newest-page size when opening a session (WeChat-style: small first screen). */
export const HISTORY_OPEN_PAGE_SIZE = 25

/** Scroll-up pagination: slightly larger chunks once user is reading history. */
export const HISTORY_OLDER_PAGE_SIZE = 40

export type SessionHistoryFetchResult = {
  messages: unknown[]
  hasMore: boolean
  oldestSeq: number | null
  messageCount?: number
}

type ChatHistoryApi = (
  sessionKey: string,
  limit: number,
  opts?: { all?: boolean; beforeSeq?: number },
) => Promise<{
  messages?: unknown[]
  hasMore?: boolean
  oldestSeq?: number | null
  messageCount?: number
}>

function normalizeResult(result: {
  messages?: unknown[]
  hasMore?: boolean
  oldestSeq?: number | null
  messageCount?: number
}): SessionHistoryFetchResult {
  const messages = Array.isArray(result?.messages) ? result.messages : []
  const oldestRaw = result?.oldestSeq
  const oldestSeq =
    oldestRaw != null && Number.isFinite(Number(oldestRaw)) ? Math.floor(Number(oldestRaw)) : null
  return {
    messages,
    hasMore: !!result?.hasMore,
    oldestSeq,
    messageCount:
      result?.messageCount != null && Number.isFinite(Number(result.messageCount))
        ? Math.max(0, Math.floor(Number(result.messageCount)))
        : undefined,
  }
}

/**
 * Open-session fetch: newest page only (``limit``, not ``all=1``).
 * Full transcript remains for share/export via ``fetchSessionHistoryAllMessages``.
 */
export async function fetchSessionHistoryMessages(
  api: ChatHistoryApi,
  sessionKey: string,
  opts?: { limit?: number },
): Promise<SessionHistoryFetchResult> {
  const lim = Math.max(1, Math.min(200, Number(opts?.limit) || HISTORY_OPEN_PAGE_SIZE))
  const result = await api(sessionKey, lim, {})
  return normalizeResult(result)
}

/** Full transcript — share / export only. */
export async function fetchSessionHistoryAllMessages(
  api: ChatHistoryApi,
  sessionKey: string,
): Promise<SessionHistoryFetchResult> {
  const result = await api(sessionKey, 0, { all: true })
  return normalizeResult({
    ...result,
    hasMore: false,
    oldestSeq: result?.oldestSeq ?? null,
  })
}

/** Scroll-up: older page strictly before ``beforeSeq``. */
export async function fetchSessionHistoryOlderMessages(
  api: ChatHistoryApi,
  sessionKey: string,
  beforeSeq: number,
  limit = HISTORY_OLDER_PAGE_SIZE,
): Promise<SessionHistoryFetchResult> {
  const lim = Math.max(1, Math.min(200, Number(limit) || HISTORY_OLDER_PAGE_SIZE))
  const seq = Math.floor(Number(beforeSeq))
  if (!Number.isFinite(seq) || seq < 1) {
    return { messages: [], hasMore: false, oldestSeq: null }
  }
  const result = await api(sessionKey, lim, { beforeSeq: seq })
  return normalizeResult(result)
}

/** After stream final: fetch recent N only to avoid full-page replace flicker. */
export async function fetchSessionHistoryTailMessages(
  api: ChatHistoryApi,
  sessionKey: string,
  limit = 24,
): Promise<SessionHistoryFetchResult> {
  const lim = Math.max(4, Math.min(200, Number(limit) || 24))
  const result = await api(sessionKey, lim, {})
  return normalizeResult(result)
}
