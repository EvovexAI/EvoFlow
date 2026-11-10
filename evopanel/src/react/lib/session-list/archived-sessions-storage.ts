import { isSpecialWorkspaceGroupKey } from './workspace-groups.js'

export const SS_ARCHIVED_SESSIONS = 'evopanel_shell_session_archived'

/**
 * 侧栏会话归档标记（对齐 zcode taskList.archive）。
 * zcode 的归档持久在 task meta；EvoFlow 会话行无对应后端字段，
 * 这里落到 localStorage（本机本 profile 生效）。
 */
export function loadArchivedSessionKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(SS_ARCHIVED_SESSIONS)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.map((v) => String(v || '').trim()).filter(Boolean))
  } catch {
    return new Set()
  }
}

export function saveArchivedSessionKeys(keys: Set<string>): void {
  try {
    localStorage.setItem(SS_ARCHIVED_SESSIONS, JSON.stringify([...keys]))
  } catch {
    /* ignore */
  }
}

export function setSessionArchived(sessionKey: string, archived: boolean): Set<string> {
  const next = loadArchivedSessionKeys()
  const key = String(sessionKey || '').trim()
  if (key) {
    if (archived) next.add(key)
    else next.delete(key)
    saveArchivedSessionKeys(next)
  }
  return next
}

/** 「移到顶部」顺序标记（对齐 zcode taskGroup.moveToTop）：workspaceKey → 有序 sessionKey 列表 */
const SS_TOPPED_SESSIONS = 'evopanel_shell_session_topped'

export type ToppedSessionOrder = Record<string, string[]>

export function loadToppedSessionOrder(): ToppedSessionOrder {
  try {
    const raw = localStorage.getItem(SS_TOPPED_SESSIONS)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: ToppedSessionOrder = {}
    for (const [wsKey, list] of Object.entries(parsed as Record<string, unknown>)) {
      const key = String(wsKey || '').trim()
      if (!key || isSpecialWorkspaceGroupKey(key) || !Array.isArray(list)) continue
      const keys = list.map((v) => String(v || '').trim()).filter(Boolean)
      if (keys.length) out[key] = keys
    }
    return out
  } catch {
    return {}
  }
}

export function saveToppedSessionOrder(order: ToppedSessionOrder): void {
  try {
    localStorage.setItem(SS_TOPPED_SESSIONS, JSON.stringify(order))
  } catch {
    /* ignore */
  }
}

/** 把会话提到其工作区分组的最前（保留既有顺序，重复置顶则再提前） */
export function topSessionInWorkspace(workspaceKey: string, sessionKey: string): ToppedSessionOrder {
  const order = loadToppedSessionOrder()
  const ws = String(workspaceKey || '').trim()
  const key = String(sessionKey || '').trim()
  if (!ws || isSpecialWorkspaceGroupKey(ws) || !key) return order
  const next = (order[ws] || []).filter((k) => k !== key)
  next.unshift(key)
  // 防膨胀：每个工作区只记最近 50 个置顶标记
  order[ws] = next.slice(0, 50)
  saveToppedSessionOrder(order)
  return order
}

export function removeToppedSession(sessionKey: string): void {
  const key = String(sessionKey || '').trim()
  if (!key) return
  const order = loadToppedSessionOrder()
  let changed = false
  for (const [ws, list] of Object.entries(order)) {
    if (list.includes(key)) {
      order[ws] = list.filter((k) => k !== key)
      changed = true
    }
  }
  if (changed) saveToppedSessionOrder(order)
}
