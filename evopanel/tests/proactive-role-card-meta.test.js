import { describe, it, expect } from 'vitest'
import {
  ROLE_DEPT_NONE,
  roleDeptFacets,
  roleDeptLabel,
  roleDescIsNameEcho,
  roleDutyOneLiner,
  roleMatchesDeptFilter,
} from '../src/lib/proactive-role-card-meta.js'

describe('proactive role card meta', () => {
  it('reads department from role or config', () => {
    expect(roleDeptLabel({ department: '研发部' })).toBe('研发部')
    expect(roleDeptLabel({ config: { department: '财务部' } })).toBe('财务部')
    expect(roleDeptLabel({ department: '  ' })).toBe('')
    expect(roleDeptLabel({ department: 'none' })).toBe('')
    expect(roleDeptLabel(null)).toBe('')
  })

  it('detects placeholder description that only echoes the name', () => {
    const role = { role_name: '飞书助理', agent_name: '飞书助理' }
    expect(roleDescIsNameEcho('员工：飞书助理', role)).toBe(true)
    expect(roleDescIsNameEcho('员工:飞书助理', role)).toBe(true)
    expect(roleDescIsNameEcho('员工：别人', role)).toBe(false)
    // 正常描述不受影响
    expect(roleDescIsNameEcho('负责飞书侧的接待与转达', role)).toBe(false)
    expect(roleDescIsNameEcho('', role)).toBe(false)
  })

  it('drops echo description so duty line stays empty', () => {
    const role = {
      role_name: '审核员',
      agent_name: '审核员',
      agent_description: '员工：审核员',
    }
    expect(roleDutyOneLiner(role)).toBe('')
  })

  it('keeps a real description', () => {
    const role = {
      role_name: '审核员',
      agent_description: '对提交内容做合规审核并给出驳回理由',
    }
    expect(roleDutyOneLiner(role)).toBe('对提交内容做合规审核并给出驳回理由')
  })

  it('does not repeat the department (chip already shows it)', () => {
    const role = {
      role_name: '后端开发工程师',
      department: '研发部',
      agent_description: '研发部',
    }
    expect(roleDutyOneLiner(role)).toBe('')
  })

  it('falls back to responsibilities when description is echo', () => {
    const role = {
      role_name: '小V',
      agent_description: '员工：小V',
      config: { responsibilities: ['接待访客', '转达消息'] },
    }
    expect(roleDutyOneLiner(role)).toBe('接待访客 · 转达消息')
  })
})

describe('role dept facets / filter', () => {
  const rows = [
    { agent_code: 'a', department: '研发部' },
    { agent_code: 'b', department: '研发部' },
    { agent_code: 'c', department: '财务部' },
    { agent_code: 'd', department: '' },
  ]

  it('counts departments in first-seen order plus unassigned', () => {
    const { depts, counts, total, noneCount } = roleDeptFacets(rows)
    expect(depts).toEqual(['研发部', '财务部'])
    expect(counts.get('研发部')).toBe(2)
    expect(counts.get('财务部')).toBe(1)
    expect(noneCount).toBe(1)
    expect(total).toBe(4)
  })

  it('filters by department, unassigned bucket, and empty (= all)', () => {
    expect(rows.filter((r) => roleMatchesDeptFilter(r, ''))).toHaveLength(4)
    expect(rows.filter((r) => roleMatchesDeptFilter(r, '研发部'))).toHaveLength(2)
    expect(rows.filter((r) => roleMatchesDeptFilter(r, ROLE_DEPT_NONE))).toHaveLength(1)
    expect(rows.filter((r) => roleMatchesDeptFilter(r, '不存在部'))).toHaveLength(0)
  })
})
