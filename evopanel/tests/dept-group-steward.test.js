import { describe, expect, it } from 'vitest'
import {
  DEPT_GROUP_STEWARD_CODE,
  DEPT_GROUP_STEWARD_NAME,
  deptGroupStewardPerson,
  isDeptGroupStewardCode,
  resolveDeptGroupWakeTargets,
} from '../src/react/lib/dept-group-steward.ts'

describe('dept-group-steward', () => {
  it('recognizes xiaomi steward codes', () => {
    expect(isDeptGroupStewardCode('xiaomi')).toBe(true)
    expect(isDeptGroupStewardCode('XIAOMI')).toBe(true)
    expect(isDeptGroupStewardCode('dev-tech')).toBe(false)
  })

  it('builds steward person for wake', () => {
    const p = deptGroupStewardPerson('研发部')
    expect(p.agent_code).toBe(DEPT_GROUP_STEWARD_CODE)
    expect(p.role_name).toBe(DEPT_GROUP_STEWARD_NAME)
    expect(p.department).toBe('研发部')
  })

  it('routes empty mentions to steward', () => {
    const { targets, viaSteward } = resolveDeptGroupWakeTargets([], '研发部')
    expect(viaSteward).toBe(true)
    expect(targets).toHaveLength(1)
    expect(targets[0].agent_code).toBe('xiaomi')
    expect(targets[0].role_name).toBe('小V')
  })

  it('keeps explicit @ targets without steward', () => {
    const mentioned = [
      { agent_code: 'dev-a', role_name: '后端' },
      { agent_code: 'dev-b', role_name: '前端' },
    ]
    const { targets, viaSteward } = resolveDeptGroupWakeTargets(mentioned, '研发部')
    expect(viaSteward).toBe(false)
    expect(targets).toEqual(mentioned)
  })
})
