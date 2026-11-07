/**
 * 左侧「部门」群聊：用合成 sessionKey，主区复用同一套壳，不另开路由。
 * key 形如 ``dept:{deptId}:chat``。
 */

export const DEPT_CHAT_SESSION_PREFIX = 'dept:'
export const DEPT_CHAT_SESSION_SUFFIX = ':chat'
export const LS_FOCUSED_DEPT_ID = 'evopanel_shell_focused_dept_id'

export type DeptChatMeta = {
  id: string
  name: string
  /** 部门头像预设 id（裸 id，如 ``studio``）；空则文字首字兜底 */
  avatar?: string
  head_agent_code?: string
  head_role_name?: string
  accent?: string
  members: Array<{
    agent_code: string
    role_name: string
    department?: string
    reports_to?: string
    status?: string
    busy?: boolean
  }>
}

const metaById = new Map<string, DeptChatMeta>()
const listeners = new Set<() => void>()

function notify() {
  listeners.forEach((fn) => {
    try {
      fn()
    } catch {
      /* ignore */
    }
  })
}

export function isDeptChatSessionKey(sessionKey: string | null | undefined): boolean {
  const sk = String(sessionKey || '').trim()
  return sk.startsWith(DEPT_CHAT_SESSION_PREFIX) && sk.endsWith(DEPT_CHAT_SESSION_SUFFIX)
}

export function deptIdFromSessionKey(sessionKey: string | null | undefined): string {
  const sk = String(sessionKey || '').trim()
  if (!isDeptChatSessionKey(sk)) return ''
  return sk.slice(DEPT_CHAT_SESSION_PREFIX.length, -DEPT_CHAT_SESSION_SUFFIX.length).trim()
}

export function deptChatSessionKey(deptId: string): string {
  const id = String(deptId || '').trim()
  if (!id) return ''
  return `${DEPT_CHAT_SESSION_PREFIX}${id}${DEPT_CHAT_SESSION_SUFFIX}`
}

export function rememberDeptChatMeta(meta: DeptChatMeta) {
  const id = String(meta?.id || '').trim()
  if (!id) return
  metaById.set(id, { ...meta, id })
  try {
    localStorage.setItem(LS_FOCUSED_DEPT_ID, id)
    sessionStorage.setItem(`evo-dept-meta:${id}`, JSON.stringify(metaById.get(id)))
  } catch {
    /* ignore */
  }
  // 顶栏标题写成「部门名 N 人」，覆盖残留的 chat 主题
  try {
    const sk = deptChatSessionKey(id)
    const title = deptChatDisplayTitle(id)
    if (sk && title) {
      void import('./session-list/display.js').then((m) => {
        try {
          m.setSessionTitle(sk, title)
        } catch {
          /* ignore */
        }
      })
    }
  } catch {
    /* ignore */
  }
  notify()
}

export function getDeptChatMeta(deptId: string): DeptChatMeta | null {
  const id = String(deptId || '').trim()
  if (!id) return null
  const hit = metaById.get(id)
  if (hit) return hit
  try {
    const raw = sessionStorage.getItem(`evo-dept-meta:${id}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as DeptChatMeta
    if (parsed?.id) {
      metaById.set(id, parsed)
      return parsed
    }
  } catch {
    /* ignore */
  }
  return null
}

/** 顶栏/侧栏展示：部门名 + 人数（常驻群，不要用 session 主题 chat） */
export function deptChatDisplayTitle(
  deptIdOrSessionKey: string | null | undefined,
): string {
  const raw = String(deptIdOrSessionKey || '').trim()
  if (!raw) return ''
  const id = isDeptChatSessionKey(raw) ? deptIdFromSessionKey(raw) : raw
  const meta = getDeptChatMeta(id)
  if (!meta?.name) return ''
  const n = Array.isArray(meta.members) ? meta.members.length : 0
  return n > 0 ? `${meta.name} ${n} 人` : meta.name
}

/** DB/解析残留的「chat」「uuid / chat」不当作用户标题 */
export function isWeakDeptChatTitle(title: string | null | undefined): boolean {
  const t = String(title || '').trim()
  if (!t) return true
  if (/^chat$/i.test(t)) return true
  if (/^[a-z0-9_-]{4,}\s*\/\s*chat$/i.test(t)) return true
  return false
}

export function loadFocusedDeptId(): string | null {
  try {
    const raw = String(localStorage.getItem(LS_FOCUSED_DEPT_ID) || '').trim()
    return raw || null
  } catch {
    return null
  }
}

export function subscribeDeptChatMeta(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
