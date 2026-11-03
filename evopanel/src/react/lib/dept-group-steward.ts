/**
 * 部门群聊：未 @ 任何人时，默认由小V（群管家）接住并灵活分派。
 */

export const DEPT_GROUP_STEWARD_CODE = 'xiaomi'
export const DEPT_GROUP_STEWARD_NAME = '小V'

export type DeptGroupStewardPerson = {
  agent_code: string
  role_name: string
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
 * 群花名册展示 / @ 选人：小V 常驻置顶（部门员工表里本来没有她）。
 */
export function withDeptGroupSteward<T extends { agent_code: string; role_name: string }>(
  members: T[],
  deptName?: string,
): T[] {
  const list = Array.isArray(members) ? members.slice() : []
  const idx = list.findIndex((m) => isDeptGroupStewardCode(m.agent_code))
  if (idx === 0) return list
  if (idx > 0) {
    const [steward] = list.splice(idx, 1)
    return [steward, ...list]
  }
  return [deptGroupStewardPerson(deptName) as unknown as T, ...list]
}

/**
 * 用户消息点名目标：有 @ 员工 → 那些人；无 @ 或只 @ 小V → 默认小V 管家。
 */
export function resolveDeptGroupWakeTargets<T extends { agent_code: string; role_name: string }>(
  mentioned: T[],
  deptName?: string,
): { targets: T[]; viaSteward: boolean } {
  const hits = Array.isArray(mentioned) ? mentioned : []
  const employees = hits.filter((m) => !isDeptGroupStewardCode(m.agent_code))
  if (employees.length > 0) {
    return { targets: employees, viaSteward: false }
  }
  return {
    targets: [deptGroupStewardPerson(deptName) as unknown as T],
    viaSteward: true,
  }
}
