/**
 * BOT 侧栏员工组排序：
 * - 企业默认：花名册编制序（部门 → 启用态 → 显示名），不因会话活跃乱跳
 * - 个人偏好：拖拽后写入 localStorage，仅覆盖本机
 */
export const SS_EMPLOYEE_GROUP_ORDER = 'evopanel_shell_employee_group_order'

export type EmployeeRosterSortable = {
  agent_code?: string | null
  agent_name?: string | null
  role_name?: string | null
  department?: string | null
  status?: string | null
}

function normalizeRosterKey(code: string | null | undefined): string {
  return String(code || '')
    .trim()
    .toLowerCase()
}

function statusRosterRank(status: string | null | undefined): number {
  const st = String(status || '')
    .trim()
    .toLowerCase()
  if (st === 'active') return 0
  if (st === 'draft') return 1
  if (st === 'paused') return 2
  return 3
}

function rosterDisplayName(role: EmployeeRosterSortable): string {
  return (
    String(role.agent_name || '').trim() ||
    String(role.role_name || '').trim() ||
    String(role.agent_code || '').trim()
  )
}

/** 企业默认编制比较：部门（未编靠后）→ 启用态 → 显示名 → agent_code */
export function compareEmployeeRoster(
  a: EmployeeRosterSortable,
  b: EmployeeRosterSortable,
): number {
  const da = String(a.department || '').trim()
  const db = String(b.department || '').trim()
  if (da && !db) return -1
  if (!da && db) return 1
  const byDept = da.localeCompare(db, 'zh-CN')
  if (byDept) return byDept
  const byStatus = statusRosterRank(a.status) - statusRosterRank(b.status)
  if (byStatus) return byStatus
  const byName = rosterDisplayName(a).localeCompare(rosterDisplayName(b), 'zh-CN')
  if (byName) return byName
  return normalizeRosterKey(a.agent_code).localeCompare(normalizeRosterKey(b.agent_code))
}

/** 花名册编制序（小写 agent_code 列表）；供侧栏默认组头排序 */
export function employeeRosterOrderKeys(
  roles: ReadonlyArray<EmployeeRosterSortable> | null | undefined,
): string[] {
  const list = Array.isArray(roles) ? [...roles] : []
  list.sort(compareEmployeeRoster)
  const seen = new Set<string>()
  const out: string[] = []
  for (const role of list) {
    const key = normalizeRosterKey(role.agent_code)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

export function loadEmployeeGroupOrder(): string[] {
  try {
    const raw = localStorage.getItem(SS_EMPLOYEE_GROUP_ORDER)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const out: string[] = []
    for (const v of parsed) {
      const k = String(v || '')
        .trim()
        .toLowerCase()
      if (!k || seen.has(k)) continue
      seen.add(k)
      out.push(k)
    }
    return out
  } catch {
    return []
  }
}

export function saveEmployeeGroupOrder(keys: string[]): void {
  try {
    const seen = new Set<string>()
    const out: string[] = []
    for (const v of keys) {
      const k = String(v || '')
        .trim()
        .toLowerCase()
      if (!k || seen.has(k)) continue
      seen.add(k)
      out.push(k)
    }
    localStorage.setItem(SS_EMPLOYEE_GROUP_ORDER, JSON.stringify(out))
  } catch {
    /* ignore */
  }
}

/** 按手动序排；未点名的跟在后面，保持相对顺序。 */
export function applyEmployeeGroupOrder<T extends { key: string }>(
  items: T[],
  order: string[],
): T[] {
  if (!items.length) return items
  if (!order.length) return items
  const rank = new Map(order.map((k, i) => [k, i]))
  return [...items].sort((a, b) => {
    const ka = String(a.key || '')
      .trim()
      .toLowerCase()
    const kb = String(b.key || '')
      .trim()
      .toLowerCase()
    const ra = rank.has(ka) ? (rank.get(ka) as number) : Number.POSITIVE_INFINITY
    const rb = rank.has(kb) ? (rank.get(kb) as number) : Number.POSITIVE_INFINITY
    if (ra !== rb) return ra - rb
    return 0
  })
}

export function reorderEmployeeGroupKeys(
  order: string[],
  fromKey: string,
  toKey: string,
  presentKeys: string[],
): string[] {
  const from = String(fromKey || '')
    .trim()
    .toLowerCase()
  const to = String(toKey || '')
    .trim()
    .toLowerCase()
  if (!from || !to || from === to) return order
  const present = presentKeys
    .map((k) =>
      String(k || '')
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean)
  const base = applyEmployeeGroupOrder(
    present.map((key) => ({ key })),
    order,
  ).map((x) => x.key)
  const fromIdx = base.indexOf(from)
  const toIdx = base.indexOf(to)
  if (fromIdx < 0 || toIdx < 0) return base
  const next = [...base]
  const [moved] = next.splice(fromIdx, 1)
  next.splice(toIdx, 0, moved)
  return next
}
