export const STORAGE_SESSION_NAMES_KEY = 'evopanel-chat-session-names'

/** One-shot: drop title cache written under GBK-mojibake proxy decode (pre UTF-8 fix). */
export const STORAGE_SESSION_NAMES_CHARSET_PURGE_KEY = 'evopanel-chat-session-names-charset-purge-v1'

/** 会话列表分页默认每页条数 */
export const SESSION_LIST_PAGE_SIZE = 20

/**
 * BOT / `__proactive__` 专属页大小。员工会话跨多人共享一个 workspace 分页；
 * 默认 20 条时每人往往只剩「最近一条」，侧栏像「每个员工只有一个对话」。
 * API `limit` 上限 200。
 */
export const SESSION_LIST_PROACTIVE_PAGE_SIZE = 100

/** 全局「最近对话」分页状态 key（非真实 workspace） */
export const GLOBAL_RECENT_PAGINATION_KEY = '__global_recent__'

export function sessionListPageSizeForWorkspace(workspaceKey: string | null | undefined): number {
  const key = String(workspaceKey || '').trim()
  if (key === '__proactive__') return SESSION_LIST_PROACTIVE_PAGE_SIZE
  return SESSION_LIST_PAGE_SIZE
}
