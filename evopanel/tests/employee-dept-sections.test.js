import { describe, it, expect } from 'vitest'
import {
  UNASSIGNED_BOT_DEPT_KEY,
  resolveBotEmployeeDeptKey,
  buildBotDeptSections,
  filterBotDeptSections,
  splitBotDeptHeadGroups,
} from '../src/react/lib/session-list/employee-dept-sections.js'

describe('employee-dept-sections', () => {
  const catalog = [
    {
      id: 'dept-sales',
      name: '销售部',
      head_agent_code: 'crm_bot',
      members: [{ agent_code: 'sales_bot' }, { agent_code: 'crm_bot' }],
    },
    {
      id: 'dept-ops',
      name: '运营部',
      members: [{ agent_code: 'ops_bot' }],
    },
  ]

  const roles = [
    { agent_code: 'sales_bot', department: '销售部' },
    { agent_code: 'crm_bot', department: '销售部' },
    { agent_code: 'ops_bot', department: '运营部' },
    { agent_code: 'orphan_bot', department: '幽灵部' },
    { agent_code: 'loose_bot', department: null },
  ]

  it('resolveBotEmployeeDeptKey prefers catalog membership over role name', () => {
    expect(resolveBotEmployeeDeptKey('sales_bot', roles, catalog)).toEqual({
      key: 'dept-sales',
      name: '销售部',
    })
    expect(resolveBotEmployeeDeptKey('loose_bot', roles, catalog)).toEqual({
      key: UNASSIGNED_BOT_DEPT_KEY,
      name: '未分部门',
    })
    expect(resolveBotEmployeeDeptKey('orphan_bot', roles, catalog)).toEqual({
      key: 'name:幽灵部',
      name: '幽灵部',
    })
  })

  it('buildBotDeptSections keeps catalog order then named extras then unassigned', () => {
    const groups = [
      { agentCode: 'loose_bot', label: '散人' },
      { agentCode: 'ops_bot', label: '运营' },
      { agentCode: 'orphan_bot', label: '幽灵' },
      { agentCode: 'sales_bot', label: '销售' },
      { agentCode: 'crm_bot', label: 'CRM' },
    ]
    const sections = buildBotDeptSections({ groups, roles, catalog })
    expect(sections.map((s) => s.key)).toEqual([
      'dept-sales',
      'dept-ops',
      'name:幽灵部',
      UNASSIGNED_BOT_DEPT_KEY,
    ])
    // 负责人 crm_bot 置顶
    expect(sections[0].groups.map((g) => g.agentCode)).toEqual(['crm_bot', 'sales_bot'])
    expect(sections.at(-1)?.name).toBe('未分部门')
  })

  it('splitBotDeptHeadGroups puts head above members', () => {
    const groups = [
      { agentCode: 'sales_bot', label: '销售' },
      { agentCode: 'crm_bot', label: 'CRM' },
    ]
    expect(splitBotDeptHeadGroups(groups, 'crm_bot')).toEqual({
      heads: [{ agentCode: 'crm_bot', label: 'CRM' }],
      members: [{ agentCode: 'sales_bot', label: '销售' }],
    })
    expect(splitBotDeptHeadGroups(groups, null).heads).toEqual([])
  })

  it('buildBotDeptSections skips empty catalog departments', () => {
    const groups = [{ agentCode: 'sales_bot', label: '销售' }]
    const sections = buildBotDeptSections({ groups, roles, catalog })
    expect(sections.map((s) => s.key)).toEqual(['dept-sales'])
  })

  it('filterBotDeptSections keeps all when focused is empty', () => {
    const sections = buildBotDeptSections({
      groups: [
        { agentCode: 'sales_bot', label: '销售' },
        { agentCode: 'ops_bot', label: '运营' },
      ],
      roles,
      catalog,
    })
    expect(filterBotDeptSections(sections, null)).toHaveLength(2)
    expect(filterBotDeptSections(sections, 'dept-ops').map((s) => s.key)).toEqual(['dept-ops'])
    expect(filterBotDeptSections(sections, UNASSIGNED_BOT_DEPT_KEY)).toEqual([])
  })
})
