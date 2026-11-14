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

const DEPT_ACCENTS = ['lead', 'commerce', 'content', 'opensource', 'knowledge', 'assistant'] as const

/** 模块级部门列表缓存：悬停预热 / 切 Tab 秒开，避免每次都亮「加载中…」 */
let cachedDeptList: DeptChatMeta[] | null = null
let cachedDeptListAt = 0
let deptListInflight: Promise<DeptChatMeta[]> | null = null
const DEPT_LIST_TTL_MS = 60_000

/** 有缓存即返回（可过期）；调用方用它秒开列表，再后台 force 刷新。 */
export function getCachedDeptList(): DeptChatMeta[] | null {
  return cachedDeptList?.length ? cachedDeptList : null
}

export function setCachedDeptList(rows: DeptChatMeta[]) {
  cachedDeptList = rows
  cachedDeptListAt = Date.now()
  for (const row of rows) {
    try {
      rememberDeptChatMeta(row)
    } catch {
      /* ignore */
    }
  }
}

/**
 * 把 `/proactive/departments`（已含 members）收成侧栏行。
 * 不再依赖二次 `/proactive/roles`——roles 在 Best-effort 车道，忙时 503 重试会把「加载中」拖很长。
 */
export function deptRowsFromDepartmentsApi(raw: unknown): DeptChatMeta[] {
  const departments = Array.isArray((raw as { departments?: unknown[] })?.departments)
    ? (raw as { departments: unknown[] }).departments
    : Array.isArray(raw)
      ? raw
      : []
  const rows: DeptChatMeta[] = []
  let ai = 0
  for (const d of departments) {
    const row = d as Record<string, unknown>
    const id = String(row?.id || '').trim()
    const name = String(row?.name || '').trim()
    if (!id || !name) continue
    const rawMembers = Array.isArray(row?.members) ? row.members : []
    const members: DeptChatMeta['members'] = []
    for (const m of rawMembers) {
      const mem = m as Record<string, unknown>
      const code = String(mem?.agent_code || mem?.code || '').trim()
      if (!code || code === 'main') continue
      members.push({
        agent_code: code,
        role_name: String(mem?.role_name || mem?.display_name || code).trim() || code,
        department: name,
        reports_to: String(mem?.reports_to || '').trim(),
        status: String(mem?.status || 'active').trim() || 'active',
        busy: false,
      })
    }
    if (!members.length) continue
    const avatar = String(row?.avatar || '').trim()
    rows.push({
      id,
      name,
      ...(avatar ? { avatar } : {}),
      head_agent_code: String(row?.head_agent_code || '').trim(),
      head_role_name: String(row?.head_role_name || '').trim(),
      accent: DEPT_ACCENTS[ai % DEPT_ACCENTS.length],
      members,
    })
    ai += 1
  }
  return rows
}

/** 预热 / 切 Tab 共用：单飞 + TTL，失败保留旧缓存 */
export async function loadDeptChatList(opts?: {
  force?: boolean
}): Promise<DeptChatMeta[]> {
  const force = opts?.force === true
  const fresh =
    cachedDeptList &&
    cachedDeptList.length > 0 &&
    Date.now() - cachedDeptListAt <= DEPT_LIST_TTL_MS
  if (!force && fresh) return cachedDeptList!
  if (deptListInflight) return deptListInflight

  deptListInflight = (async () => {
    const { api } = await import('../../lib/tauri-api.js')
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    let last: unknown
    for (let i = 0; i < 3; i++) {
      try {
        const deptRes = await api.proactiveListDepartments()
        const rows = deptRowsFromDepartmentsApi(deptRes)
        setCachedDeptList(rows)
        return rows
      } catch (e) {
        last = e
        if (i < 2) await sleep(280 * (i + 1))
      }
    }
    if (cachedDeptList?.length) return cachedDeptList
    throw last
  })()

  try {
    return await deptListInflight
  } finally {
    deptListInflight = null
  }
}

export function prefetchDeptChatList(): void {
  void loadDeptChatList().catch(() => {})
}
