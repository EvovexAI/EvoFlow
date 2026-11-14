import { describe, expect, it } from 'vitest'
import {
  deptRowsFromDepartmentsApi,
  getCachedDeptList,
  setCachedDeptList,
} from '../src/react/lib/dept-chat-session.ts'

describe('deptRowsFromDepartmentsApi', () => {
  it('builds sidebar rows from departments.members without roles join', () => {
    const rows = deptRowsFromDepartmentsApi({
      departments: [
        {
          id: 'd1',
          name: '内容部',
          avatar: 'studio',
          head_agent_code: 'writer',
          head_role_name: '撰稿',
          members: [
            { agent_code: 'writer', role_name: '撰稿', status: 'active', reports_to: '' },
            { agent_code: 'main', role_name: '主脑', status: 'active' },
            { agent_code: 'editor', role_name: '编辑', status: 'active', reports_to: 'writer' },
          ],
        },
        { id: 'd2', name: '空部门', members: [] },
      ],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'd1',
      name: '内容部',
      avatar: 'studio',
      head_agent_code: 'writer',
      head_role_name: '撰稿',
    })
    expect(rows[0].members.map((m) => m.agent_code)).toEqual(['writer', 'editor'])
    expect(rows[0].members[1].reports_to).toBe('writer')
  })

  it('round-trips module cache for instant tab paint', () => {
    setCachedDeptList([
      {
        id: 'x',
        name: '测试部',
        accent: 'lead',
        members: [{ agent_code: 'a', role_name: 'A', department: '测试部' }],
      },
    ])
    expect(getCachedDeptList()?.[0]?.name).toBe('测试部')
  })
})
