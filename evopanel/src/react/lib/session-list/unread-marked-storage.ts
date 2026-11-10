export const SS_UNREAD_MARKED_SESSIONS = 'evopanel_shell_session_unread'

/**
 * 侧栏「标为未读」标记（对齐 zcode taskList.markAsUnread）。
 * zcode 持久在 task meta；EvoFlow 落 localStorage，点开会话即清除。
 */
export function loadUnreadMarkedKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(SS_UNREAD_MARKED_SESSIONS)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.map((v) => String(v || '').trim()).filter(Boolean))
  } catch {
    return new Set()
  }
}

export function saveUnreadMarkedKeys(keys: Set<string>): void {
  try {
    localStorage.setItem(SS_UNREAD_MARKED_SESSIONS, JSON.stringify([...keys]))
  } catch {
    /* ignore */
  }
}

export function markSessionUnread(sessionKey: string, unread: boolean): Set<string> {
  const next = loadUnreadMarkedKeys()
  const key = String(sessionKey || '').trim()
  if (key) {
    if (unread) next.add(key)
    else next.delete(key)
    saveUnreadMarkedKeys(next)
  }
  return next
}
