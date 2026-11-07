import { describe, it, expect } from 'vitest'
import {
  parseEmployeeSessionOwner,
  isOrphanEmployeeSessionRow,
  pruneOrphanEmployeeSessions,
} from '../src/react/lib/session-list/employee-session-prune.js'
import { mergeSessionsFromApi } from '../src/react/lib/session-list/utils.js'

describe('parseEmployeeSessionOwner (mirror of backend _SESSION_OWNER_CODE_SQL)', () => {
  it('extracts owner from proactive keys, first segment only', () => {
    expect(parseEmployeeSessionOwner('proactive:zhangsan')).toBe('zhangsan')
    expect(parseEmployeeSessionOwner('proactive:zhangsan:duty:2026')).toBe('zhangsan')
    expect(parseEmployeeSessionOwner('proactive:zhangsan:chat:abc')).toBe('zhangsan')
  })

  it('extracts owner from agent keys', () => {
    expect(parseEmployeeSessionOwner('agent:zhangsan:feishu:ou_x')).toBe('zhangsan')
    expect(parseEmployeeSessionOwner('agent:lisi:web:default')).toBe('lisi')
  })

  it('non-employee key shapes return empty owner', () => {
    expect(parseEmployeeSessionOwner('dept_group:42')).toBe('')
    expect(parseEmployeeSessionOwner('thread:abc')).toBe('')
    expect(parseEmployeeSessionOwner('main')).toBe('')
    expect(parseEmployeeSessionOwner('')).toBe('')
    expect(parseEmployeeSessionOwner(null)).toBe('')
    expect(parseEmployeeSessionOwner(undefined)).toBe('')
  })

  it('colon-leading owner segment resolves to empty like backend', () => {
    expect(parseEmployeeSessionOwner('proactive::chat:x')).toBe('')
    expect(parseEmployeeSessionOwner('agent::feishu:ou_x')).toBe('')
  })

  it('bare family prefix yields empty owner', () => {
    expect(parseEmployeeSessionOwner('proactive:')).toBe('')
    expect(parseEmployeeSessionOwner('agent:')).toBe('')
  })
})

describe('isOrphanEmployeeSessionRow', () => {
  const roster = new Set(['zhangsan', 'lisi'])

  it('orphan when owner-shaped and not in roster', () => {
    expect(
      isOrphanEmployeeSessionRow({ sessionKey: 'proactive:gone-emp:duty:1' }, roster),
    ).toBe(true)
    expect(isOrphanEmployeeSessionRow({ sessionKey: 'agent:gone-emp:feishu:ou_x' }, roster)).toBe(
      true,
    )
  })

  it('live employee sessions are kept', () => {
    expect(isOrphanEmployeeSessionRow({ sessionKey: 'proactive:zhangsan:duty:1' }, roster)).toBe(
      false,
    )
    expect(isOrphanEmployeeSessionRow({ sessionKey: 'agent:lisi:web:default' }, roster)).toBe(false)
  })

  it('system-reserved owners and IM open-ids are never orphans', () => {
    expect(isOrphanEmployeeSessionRow({ sessionKey: 'agent:main:feishu:ou_x' }, roster)).toBe(false)
    expect(isOrphanEmployeeSessionRow({ sessionKey: 'agent:executor:task:1' }, roster)).toBe(false)
    expect(isOrphanEmployeeSessionRow({ sessionKey: 'agent:lead_agent:web:x' }, roster)).toBe(false)
    expect(isOrphanEmployeeSessionRow({ sessionKey: 'agent:agent:web:x' }, roster)).toBe(false)
    expect(isOrphanEmployeeSessionRow({ sessionKey: 'agent:ou_abc123:feishu:chat' }, roster)).toBe(
      false,
    )
    expect(isOrphanEmployeeSessionRow({ sessionKey: 'proactive:ou_abc123' }, roster)).toBe(false)
  })

  it('non-employee key shapes are never orphans', () => {
    expect(isOrphanEmployeeSessionRow({ sessionKey: 'dept_group:42' }, roster)).toBe(false)
    expect(isOrphanEmployeeSessionRow({ sessionKey: '' }, roster)).toBe(false)
  })

  it('empty roster means every employee-owned row is orphan', () => {
    expect(isOrphanEmployeeSessionRow({ sessionKey: 'proactive:zhangsan' }, new Set())).toBe(true)
  })
})

describe('pruneOrphanEmployeeSessions', () => {
  it('null/undefined roster fails open (no pruning)', () => {
    const rows = [{ sessionKey: 'proactive:gone:duty:1' }]
    expect(pruneOrphanEmployeeSessions(rows, null)).toBe(rows)
    expect(pruneOrphanEmployeeSessions(rows, undefined)).toBe(rows)
  })

  it('drops only orphan employee rows', () => {
    const rows = [
      { sessionKey: 'proactive:gone:duty:1', title: '离职员工' },
      { sessionKey: 'proactive:zhangsan:duty:1', title: '张三' },
      { sessionKey: 'agent:main:feishu:ou_x', title: '主助手' },
      { sessionKey: 'dept_group:42', title: '部门群' },
    ]
    const out = pruneOrphanEmployeeSessions(rows, new Set(['zhangsan']))
    expect(out.map((r) => r.sessionKey)).toEqual([
      'proactive:zhangsan:duty:1',
      'agent:main:feishu:ou_x',
      'dept_group:42',
    ])
  })
})

describe('mergeSessionsFromApi orphan employee pruning', () => {
  const roster = new Set(['zhangsan'])

  it('does not glue back orphan rows that the API no longer returns', () => {
    const prev = [
      { sessionKey: 'proactive:gone:duty:1', title: '离职员工', createdAt: 1, updatedAt: 1 },
      { sessionKey: 'proactive:zhangsan:duty:1', title: '张三', createdAt: 2, updatedAt: 2 },
    ]
    const apiRows = [
      { sessionKey: 'proactive:zhangsan:duty:1', title: '张三', createdAt: 2, updatedAt: 2 },
    ]
    const merged = mergeSessionsFromApi(prev, apiRows, '', { liveEmployeeCodes: roster })
    expect(merged.map((s) => s.sessionKey)).toEqual(['proactive:zhangsan:duty:1'])
  })

  it('without roster (null) keeps the old union-merge behavior', () => {
    const prev = [
      { sessionKey: 'proactive:gone:duty:1', title: '离职员工', createdAt: 1, updatedAt: 1 },
    ]
    const merged = mergeSessionsFromApi(prev, [], '', { liveEmployeeCodes: null })
    expect(merged.map((s) => s.sessionKey)).toEqual(['proactive:gone:duty:1'])
  })

  it('never prunes the current session even if orphaned', () => {
    const prev = [
      { sessionKey: 'proactive:gone:duty:1', title: '正在看的对话', createdAt: 1, updatedAt: 1 },
    ]
    const merged = mergeSessionsFromApi(prev, [], 'proactive:gone:duty:1', {
      liveEmployeeCodes: roster,
    })
    expect(merged.map((s) => s.sessionKey)).toEqual(['proactive:gone:duty:1'])
    expect(merged[0].title).toBe('正在看的对话')
  })

  it('prunes orphan rows that came inside the API payload too', () => {
    const apiRows = [
      { sessionKey: 'proactive:gone:duty:1', title: '离职员工', createdAt: 1, updatedAt: 1 },
      { sessionKey: 'agent:main:web:x', title: '主助手', createdAt: 3, updatedAt: 3 },
    ]
    const merged = mergeSessionsFromApi([], apiRows, '', { liveEmployeeCodes: roster })
    expect(merged.map((s) => s.sessionKey)).toEqual(['agent:main:web:x'])
  })
})
