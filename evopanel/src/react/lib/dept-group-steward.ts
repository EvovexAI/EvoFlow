/**
 * 部门群聊默认承接：
 * - 有 @ 员工 → 叫醒被点名的人
 * - 无人 @ → **部门负责人**承接
 * - 无负责人 → 花名册里第一个真人成员（不再伪造注入小V）
 *
 * 小V **不再**默认塞进每个部门群。她只出现在真正所属部门的 members 里；
 * 只有用户在那个群里 @ 到她时，才走管家模式。
 */

export const DEPT_GROUP_STEWARD_CODE = 'xiaomi'
export const DEPT_GROUP_STEWARD_NAME = '小V'

export type DeptGroupStewardPerson = {
  agent_code: string
  role_name: string
}

export type DeptGroupWakeHead = {
  agent_code: string
  role_name: string
}

export type ResolveDeptGroupWakeOpts = {
  deptName?: string
  /** 部门负责人；无人 @ 时优先叫醒 */
  head?: DeptGroupWakeHead | null
  /**
   * 无负责人时的回落成员（通常取花名册第一人）。
   * 不要传伪造的小V；小V 不在本部门就不要出现。
   */
  fallback?: DeptGroupWakeHead | null
}

export function isDeptGroupStewardCode(code: string | null | undefined): boolean {
  const c = String(code || '').trim().toLowerCase()
  return c === DEPT_GROUP_STEWARD_CODE || c === 'xiaov' || c === '小v' || c === '小蜜'
}

export function deptGroupStewardPerson(deptName?: string): DeptGroupStewardPerson & {
  department: string
  reports_to: string
  status: string
  busy: boolean
  summary: string
} {
  return {
    agent_code: DEPT_GROUP_STEWARD_CODE,
    role_name: DEPT_GROUP_STEWARD_NAME,
    department: String(deptName || '').trim(),
    reports_to: '',
    status: 'active',
    busy: false,
    summary: '',
  }
}

/**
 * 群花名册：原样返回本部门成员。
 * 历史名 withDeptGroupSteward —— 曾默认注入小V，已取消；保留函数名以免大面积改调用方。
 */
export function withDeptGroupSteward<T extends { agent_code: string; role_name: string }>(
  members: T[],
  _deptName?: string,
): T[] {
  return Array.isArray(members) ? members.slice() : []
}

function normalizeOpts(
  opts?: string | ResolveDeptGroupWakeOpts,
): ResolveDeptGroupWakeOpts {
  if (typeof opts === 'string') return { deptName: opts }
  return opts && typeof opts === 'object' ? opts : {}
}

function normalizePerson(
  person: DeptGroupWakeHead | null | undefined,
): DeptGroupWakeHead | null {
  if (!person) return null
  const code = String(person.agent_code || '').trim()
  if (!code) return null
  const role = String(person.role_name || '').trim() || code
  return { agent_code: code, role_name: role }
}

/**
 * 用户消息点名目标：
 * - 有 @ 员工 → 那些人
 * - 只 @ 小V（且她在本群花名册里）→ 小V 管家
 * - 无人 @ → 部门负责人；无负责人 → fallback 成员；再没有 → 空
 */
export function resolveDeptGroupWakeTargets<T extends { agent_code: string; role_name: string }>(
  mentioned: T[],
  opts?: string | ResolveDeptGroupWakeOpts,
): { targets: T[]; viaSteward: boolean; viaHeadDefault: boolean } {
  const { head, fallback } = normalizeOpts(opts)
  const hits = Array.isArray(mentioned) ? mentioned : []
  const employees = hits.filter((m) => !isDeptGroupStewardCode(m.agent_code))
  if (employees.length > 0) {
    return { targets: employees, viaSteward: false, viaHeadDefault: false }
  }

  // 显式 @ 到花名册里的小V（不会凭空造一个）
  const stewardHits = hits.filter((m) => isDeptGroupStewardCode(m.agent_code))
  if (stewardHits.length > 0) {
    return {
      targets: stewardHits,
      viaSteward: true,
      viaHeadDefault: false,
    }
  }

  const headPerson = normalizePerson(head)
  if (headPerson && !isDeptGroupStewardCode(headPerson.agent_code)) {
    return {
      targets: [headPerson as unknown as T],
      viaSteward: false,
      viaHeadDefault: true,
    }
  }

  const fallbackPerson = normalizePerson(fallback)
  if (fallbackPerson) {
    return {
      targets: [fallbackPerson as unknown as T],
      viaSteward: isDeptGroupStewardCode(fallbackPerson.agent_code),
      viaHeadDefault: false,
    }
  }

  return { targets: [], viaSteward: false, viaHeadDefault: false }
}
