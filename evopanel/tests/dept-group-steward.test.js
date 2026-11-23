import { describe, expect, it } from 'vitest'
import {
  DEPT_GROUP_STEWARD_CODE,
  DEPT_GROUP_STEWARD_NAME,
  deptGroupStewardPerson,
  isDeptGroupStewardCode,
  resolveDeptGroupWakeTargets,
  withDeptGroupSteward,
} from '../src/react/lib/dept-group-steward.ts'

describe('dept-group-steward', () => {
  it('recognizes xiaomi steward codes', () => {
    expect(isDeptGroupStewardCode('xiaomi')).toBe(true)
    expect(isDeptGroupStewardCode('XIAOMI')).toBe(true)
    expect(isDeptGroupStewardCode('dev-tech')).toBe(false)
  })

  it('builds steward person helper (for explicit wake only)', () => {
    const p = deptGroupStewardPerson('研发部')
    expect(p.agent_code).toBe(DEPT_GROUP_STEWARD_CODE)
    expect(p.role_name).toBe(DEPT_GROUP_STEWARD_NAME)
    expect(p.department).toBe('研发部')
  })

  it('does not inject 小V into every department roster', () => {
    const roster = withDeptGroupSteward(
      [{ agent_code: 'dev-a', role_name: '全栈' }],
      '研发部',
    )
    expect(roster).toHaveLength(1)
    expect(roster[0].agent_code).toBe('dev-a')
    expect(roster.some((m) => m.agent_code === 'xiaomi')).toBe(false)
  })

  it('keeps 小V only when she is already a real member', () => {
    const roster = withDeptGroupSteward(
      [
        { agent_code: 'dev-a', role_name: '全栈' },
        { agent_code: 'xiaomi', role_name: '小V' },
      ],
      '行政部',
    )
    expect(roster).toHaveLength(2)
    expect(roster.some((m) => m.agent_code === 'xiaomi')).toBe(true)
  })

  it('routes empty mentions to department head when present', () => {
    const { targets, viaSteward, viaHeadDefault } = resolveDeptGroupWakeTargets([], {
      deptName: '研发部',
      head: { agent_code: 'cto', role_name: '技术总监' },
    })
    expect(viaSteward).toBe(false)
    expect(viaHeadDefault).toBe(true)
    expect(targets).toHaveLength(1)
    expect(targets[0].agent_code).toBe('cto')
  })

  it('falls back to roster member when no head — not a forged 小V', () => {
    const { targets, viaSteward, viaHeadDefault } = resolveDeptGroupWakeTargets([], {
      deptName: '研发部',
      fallback: { agent_code: 'dev-a', role_name: '全栈' },
    })
    expect(viaSteward).toBe(false)
    expect(viaHeadDefault).toBe(false)
    expect(targets).toHaveLength(1)
    expect(targets[0].agent_code).toBe('dev-a')
  })

  it('returns empty when no head and no fallback', () => {
    const { targets, viaSteward, viaHeadDefault } = resolveDeptGroupWakeTargets([], '研发部')
    expect(targets).toEqual([])
    expect(viaSteward).toBe(false)
    expect(viaHeadDefault).toBe(false)
  })

  it('routes explicit @小V only when she appears in mentioned (real roster hit)', () => {
    const { targets, viaSteward, viaHeadDefault } = resolveDeptGroupWakeTargets(
      [{ agent_code: 'xiaomi', role_name: '小V' }],
      {
        deptName: '行政部',
        head: { agent_code: 'hr-lead', role_name: '人事主管' },
      },
    )
    expect(viaSteward).toBe(true)
    expect(viaHeadDefault).toBe(false)
    expect(targets).toHaveLength(1)
    expect(targets[0].agent_code).toBe('xiaomi')
  })

  it('keeps explicit @ employee targets', () => {
    const mentioned = [
      { agent_code: 'dev-a', role_name: '后端' },
      { agent_code: 'dev-b', role_name: '前端' },
    ]
    const { targets, viaSteward, viaHeadDefault } = resolveDeptGroupWakeTargets(mentioned, {
      deptName: '研发部',
      head: { agent_code: 'cto', role_name: '技术总监' },
    })
    expect(viaSteward).toBe(false)
    expect(viaHeadDefault).toBe(false)
    expect(targets).toEqual(mentioned)
  })
})
