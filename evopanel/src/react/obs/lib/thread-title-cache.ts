const STORAGE_KEY = 'evopanel_thread_title_map_v1'

let memoryMap: Map<string, string> | null = null
let inflight: Promise<Map<string, string>> | null = null

function isPlaceholderTitle(title: string): boolean {
  const t = title.trim()
  if (!t) return true
  return t === '新对话' || t.toLowerCase() === 'new conversation'
}

function loadFromStorage(): Map<string, string> {
  const map = new Map<string, string>()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return map
    const parsed = JSON.parse(raw) as { entries?: Record<string, string> }
    for (const [tid, title] of Object.entries(parsed?.entries || {})) {
      const id = String(tid || '').trim()
      const label = String(title || '').trim()
      if (id && label && !isPlaceholderTitle(label)) map.set(id, label)
    }
  } catch {
    /* ignore */
  }
  return map
}

function saveToStorage(map: Map<string, string>) {
  try {
    const entries: Record<string, string> = {}
    for (const [tid, title] of map.entries()) entries[tid] = title
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, entries, updatedAt: Date.now() }))
  } catch {
    /* ignore */
  }
}

export function getThreadTitleMap(): Map<string, string> {
  if (!memoryMap) memoryMap = loadFromStorage()
  return memoryMap
}

export function mergeThreadTitles(entries: Iterable<[string, string]>) {
  const map = getThreadTitleMap()
  let changed = false
  for (const [rawId, rawTitle] of entries) {
    const tid = String(rawId || '').trim()
    const title = String(rawTitle || '').trim()
    if (!tid || !title || isPlaceholderTitle(title)) continue
    if (map.get(tid) !== title) {
      map.set(tid, title)
      changed = true
    }
  }
  if (changed) saveToStorage(map)
  return map
}

export function getThreadTitle(threadId: string | null | undefined): string | null {
  const tid = String(threadId || '').trim()
  if (!tid || tid === '—') return null
  return getThreadTitleMap().get(tid) ?? null
}

export function threadDisplayLabel(threadId: string | null | undefined, title?: string | null): string {
  const tid = String(threadId || '').trim()
  if (!tid || tid === '—') return '—'
  const label = String(title || getThreadTitle(tid) || '').trim()
  if (label) return label
  if (tid.length <= 16) return tid
  return `${tid.slice(0, 8)}…${tid.slice(-4)}`
}

async function fetchTitlesByThreadIds(threadIds: string[]): Promise<Map<string, string>> {
  if (!threadIds.length) return getThreadTitleMap()
  // @ts-ignore
  const { gatewayProxy } = await import('../../../lib/tauri-api.js')
  const res = (await gatewayProxy(
    'GET',
    '/chat/sessions/titles-by-thread',
    null,
    { thread_ids: threadIds.join(',') },
    { silent: true },
  )) as { titles?: Record<string, string> }
  const titles = res?.titles || {}
  mergeThreadTitles(Object.entries(titles))
  return getThreadTitleMap()
}

async function fetchRecentSessionTitles(limit = 200): Promise<Map<string, string>> {
  // @ts-ignore
  const { gatewayProxy } = await import('../../../lib/tauri-api.js')
  const res = (await gatewayProxy(
    'GET',
    '/chat/sessions',
    null,
    { limit: String(limit), offset: '0' },
    { silent: true },
  )) as { sessions?: { threadId?: string; thread_id?: string; title?: string }[]; items?: unknown[] }
  const sessions = res?.sessions || res?.items || []
  if (!Array.isArray(sessions)) return getThreadTitleMap()
  mergeThreadTitles(
    // @ts-ignore
    sessions.map((s) => [String(s.threadId || s.thread_id || ''), String(s.title || '')] as [string, string]),
  )
  return getThreadTitleMap()
}

/** Load cached titles and resolve any missing thread ids (deduped, batched). */
export async function ensureThreadTitles(threadIds: Iterable<string | null | undefined> = []): Promise<Map<string, string>> {
  const map = getThreadTitleMap()
  const missing: string[] = []
  const seen = new Set<string>()
  for (const raw of threadIds) {
    const tid = String(raw || '').trim()
    if (!tid || tid === '—' || seen.has(tid)) continue
    seen.add(tid)
    if (!map.has(tid)) missing.push(tid)
  }

  if (!missing.length && map.size > 0) return map
  if (inflight) return inflight

  inflight = (async () => {
    if (map.size === 0) {
      try {
        await fetchRecentSessionTitles(200)
      } catch {
        /* optional */
      }
    }
    const stillMissing = missing.filter((tid) => !getThreadTitleMap().has(tid))
    if (stillMissing.length) {
      for (let i = 0; i < stillMissing.length; i += 80) {
        const chunk = stillMissing.slice(i, i + 80)
        try {
          await fetchTitlesByThreadIds(chunk)
        } catch {
          /* optional */
        }
      }
    }
    return getThreadTitleMap()
  })().finally(() => {
    inflight = null
  })

  return inflight
}

export function primeThreadTitleCacheFromSessions(
  sessions: { threadId?: string; thread_id?: string; title?: string }[],
) {
  mergeThreadTitles(
    sessions.map((s) => [String(s.threadId || s.thread_id || ''), String(s.title || '')] as [string, string]),
  )
}