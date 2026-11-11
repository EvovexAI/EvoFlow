import { describe, expect, it } from 'vitest'
import {
  applyEmployeeGroupOrder,
  compareEmployeeRoster,
  employeeRosterOrderKeys,
  reorderEmployeeGroupKeys,
} from '../src/react/lib/session-list/employee-group-order-storage.js'

describe('employee-group-order-storage', () => {
  it('applyEmployeeGroupOrder puts named keys first, keeps relative order of others', () => {
    const items = [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }]
    expect(applyEmployeeGroupOrder(items, ['c', 'a']).map((x) => x.key)).toEqual([
      'c',
      'a',
      'b',
      'd',
    ])
  })

  it('reorderEmployeeGroupKeys moves fromKey before/onto toKey among present keys', () => {
    const next = reorderEmployeeGroupKeys(['a', 'b', 'c'], 'c', 'a', ['a', 'b', 'c'])
    expect(next).toEqual(['c', 'a', 'b'])
  })

  it('reorderEmployeeGroupKeys is case-insensitive and fills missing order from present', () => {
    const next = reorderEmployeeGroupKeys([], 'B', 'A', ['a', 'b', 'c'])
    expect(next).toEqual(['b', 'a', 'c'])
  })

  it('employeeRosterOrderKeys sorts by department then status then name (stable org order)', () => {
    const keys = employeeRosterOrderKeys([
      { agent_code: 'z', agent_name: '张三', department: '研发', status: 'paused' },
      { agent_code: 'a', agent_name: '阿一', department: '', status: 'active' },
      { agent_code: 'b', agent_name: '小B', department: '研发', status: 'active' },
      { agent_code: 'c', agent_name: '小C', department: '运营', status: 'active' },
    ])
    // 有部门的在前（部门名 zh locale）；同部门 active 先于 paused；未编部门沉底
    expect(keys).toEqual(['b', 'z', 'c', 'a'])
  })

  it('compareEmployeeRoster keeps启用 before 停用 within same dept', () => {
    expect(
      compareEmployeeRoster(
        { agent_code: 'x', department: 'A', status: 'active', agent_name: '后' },
        { agent_code: 'y', department: 'A', status: 'paused', agent_name: '前' },
      ),
    ).toBeLessThan(0)
  })
})
