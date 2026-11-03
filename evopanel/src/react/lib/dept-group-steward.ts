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
 * 用户消息点名目标：有 @ → 那些人；无 @ → 默认小V。
 */
export function resolveDeptGroupWakeTargets<T extends { agent_code: string; role_name: string }>(
  mentioned: T[],
  deptName?: string,
): { targets: T[]; viaSteward: boolean } {
  if (Array.isArray(mentioned) && mentioned.length > 0) {
    return { targets: mentioned, viaSteward: false }
  }
  return {
    targets: [deptGroupStewardPerson(deptName) as unknown as T],
    viaSteward: true,
  }
}
