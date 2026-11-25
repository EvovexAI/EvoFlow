/**
 * BOT 侧栏：按部门编组员工（花名册 department 名 / 部门成员表双源对齐）。
 */

export const UNASSIGNED_BOT_DEPT_KEY = '__unassigned__'

export type BotDeptCatalogEntry = {
  id: string
  name: string
  head_agent_code?: string | null
  members?: ReadonlyArray<{ agent_code?: string | null }>
}

export type BotEmployeeGroupLike = {
  agentCode: string
  label: string
}

export type BotEmployeeRoleLike = {
  agent_code?: string | null
  department?: string | null
}

export type BotDeptSection<T extends BotEmployeeGroupLike> = {
  /** 部门 id，或 {@link UNASSIGNED_BOT_DEPT_KEY} */
  key: string
  name: string
  groups: T[]
}

function normalizeCode(code: string | null | undefined): string {
  return String(code || '')
    .trim()
    .toLowerCase()
}

/** 岗位所属部门：优先成员表命中，其次 role.department 名匹配目录。 */
export function resolveBotEmployeeDeptKey(
  agentCode: string,
  roles: ReadonlyArray<BotEmployeeRoleLike> | null | undefined,
  catalog: ReadonlyArray<BotDeptCatalogEntry> | null | undefined,
): { key: string; name: string } {
  const lc = normalizeCode(agentCode)
  if (!lc) return { key: UNASSIGNED_BOT_DEPT_KEY, name: '未分部门' }

  const depts = Array.isArray(catalog) ? catalog : []
  for (const d of depts) {
    const id = String(d?.id || '').trim()
    if (!id) continue
    const members = Array.isArray(d.members) ? d.members : []
    if (members.some((m: { agent_code?: string | null }) => normalizeCode(m?.agent_code) === lc)) {
      return { key: id, name: String(d.name || '').trim() || id }
    }
  }

  const role = (Array.isArray(roles) ? roles : []).find(
    (r) => normalizeCode(r?.agent_code) === lc,
  )
  const deptName = String(role?.department || '').trim()
  if (deptName) {
    const hit = depts.find(
      (d) => String(d?.name || '').trim().toLowerCase() === deptName.toLowerCase(),
    )
    if (hit && String(hit.id || '').trim()) {
      return { key: String(hit.id).trim(), name: String(hit.name || '').trim() || deptName }
    }
    // 目录里没有同名部门时仍按名称成组（避免全掉进未分）
    return { key: `name:${deptName.toLowerCase()}`, name: deptName }
  }

  return { key: UNASSIGNED_BOT_DEPT_KEY, name: '未分部门' }
}

/**
 * 把员工组挂到部门下。顺序：目录序 → 仅有名的部门 → 未分部门。
 * 空部门不出现（BOT 侧栏只展示有人的组）。
 */
export function buildBotDeptSections<T extends BotEmployeeGroupLike>(input: {
  groups: ReadonlyArray<T>
  roles?: ReadonlyArray<BotEmployeeRoleLike> | null
  catalog?: ReadonlyArray<BotDeptCatalogEntry> | null
}): BotDeptSection<T>[] {
  const groups = Array.isArray(input.groups) ? input.groups : []
  if (!groups.length) return []

  const catalog = Array.isArray(input.catalog) ? input.catalog : []
  const roles = input.roles
  const bucket = new Map<string, BotDeptSection<T>>()

  const ensure = (key: string, name: string) => {
    let sec = bucket.get(key)
    if (!sec) {
      sec = { key, name, groups: [] }
      bucket.set(key, sec)
    }
    return sec
  }

  for (const g of groups) {
    const code = String(g?.agentCode || '').trim()
    if (!code) continue
    const resolved = resolveBotEmployeeDeptKey(code, roles, catalog)
    ensure(resolved.key, resolved.name).groups.push(g)
  }

  // 组内：负责人置顶（便于侧栏「负责人 / 员工」分层）
  const headByDeptId = new Map<string, string>()
  for (const d of catalog) {
    const id = String(d?.id || '').trim()
    const head = normalizeCode(d?.head_agent_code)
    if (id && head) headByDeptId.set(id, head)
  }
  for (const sec of bucket.values()) {
    const headLc = headByDeptId.get(sec.key)
    if (!headLc) continue
    sec.groups.sort((a, b) => {
      const aH = normalizeCode(a.agentCode) === headLc
      const bH = normalizeCode(b.agentCode) === headLc
      if (aH && !bH) return -1
      if (!aH && bH) return 1
      return 0
    })
  }

  const out: BotDeptSection<T>[] = []
  const seen = new Set<string>()

  for (const d of catalog) {
    const id = String(d?.id || '').trim()
    if (!id) continue
    const sec = bucket.get(id)
    if (!sec || !sec.groups.length) continue
    out.push(sec)
    seen.add(id)
  }

  const namedExtras = [...bucket.values()]
    .filter((s) => !seen.has(s.key) && s.key !== UNASSIGNED_BOT_DEPT_KEY && s.groups.length)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  out.push(...namedExtras)

  const unassigned = bucket.get(UNASSIGNED_BOT_DEPT_KEY)
  if (unassigned && unassigned.groups.length) out.push(unassigned)

  return out
}

/** 部门筛选：null=全部；否则只留匹配 key（含未分）。 */
export function filterBotDeptSections<T extends BotEmployeeGroupLike>(
  sections: ReadonlyArray<BotDeptSection<T>>,
  focusedDeptKey: string | null | undefined,
): BotDeptSection<T>[] {
  const key = String(focusedDeptKey || '').trim()
  if (!key) return [...sections]
  return sections.filter((s) => s.key === key)
}

/** 按负责人拆开组：heads 在前，rest 为普通员工。 */
export function splitBotDeptHeadGroups<T extends BotEmployeeGroupLike>(
  groups: ReadonlyArray<T>,
  headAgentCode: string | null | undefined,
): { heads: T[]; members: T[] } {
  const headLc = normalizeCode(headAgentCode)
  if (!headLc) return { heads: [], members: [...groups] }
  const heads: T[] = []
  const members: T[] = []
  for (const g of groups) {
    if (normalizeCode(g.agentCode) === headLc) heads.push(g)
    else members.push(g)
  }
  return { heads, members }
}
