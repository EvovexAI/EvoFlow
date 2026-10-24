import { describe, expect, it } from 'vitest'
import { buildHomeLiveItems } from '../src/react/lib/home-live-activity.js'

describe('buildHomeLiveItems', () => {
  const helpers = {
    isTaskRunning: (status: unknown) => {
      const s = String(status || '').toLowerCase()
      return s === 'executing' || s === 'running' || s === 'planning'
    },
    taskSourceKey: (t: any) => String(t?.source || 'other'),
    taskTitle: (t: any) => String(t?.name || t?.title || 'task'),
    taskHref: (t: any) => `#/task/${t.id}`,
    formatTaskSourceZh: (src: unknown) => (src === 'workflow' ? '工作流' : String(src || '')),
  }

  it('classifies chat / employee / automation sessions and workflow tasks', () => {
    const items = buildHomeLiveItems({
      activeSessions: {
        active_sessions: [
          { session_key: 'agent:main:abc', title: '写周报', agent_id: 'main', status: 'running' },
          {
            session_key: 'proactive:sales:duty:1',
            title: '销售 · 值班',
            agent_id: 'sales',
            status: 'running',
          },
          {
            session_key: 'automation:cron-1:run-9',
            title: '',
            status: 'pending',
          },
        ],
      },
      roles: [{ agent_code: 'sales', role_name: '销售助手' }],
      roleBusyByCode: {
        ops: { busy: true, current_session_key: '' },
      },
      automations: [{ id: 'cron-1', name: '每日巡检' }],
      tasks: [
        { id: 't1', name: '发版流程', source: 'workflow', status: 'executing' },
        { id: 't2', name: '普通对话任务', source: 'chat', status: 'executing' },
      ],
      ...helpers,
    })

    const kinds = items.map((i) => i.kind)
    expect(kinds).toContain('chat')
    expect(kinds).toContain('employee')
    expect(kinds).toContain('automation')
    expect(kinds).toContain('workflow')

    const auto = items.find((i) => i.kind === 'automation')
    expect(auto?.title).toBe('每日巡检')

    const chat = items.find((i) => i.kind === 'chat')
    expect(chat?.title).toBe('写周报')
    expect(chat?.sessionKey).toBe('agent:main:abc')

    // busy role without overlapping session
    expect(items.some((i) => i.id === 'employee:ops')).toBe(true)
    // chat-sourced running task is NOT listed (sessions cover chat liveness)
    expect(items.some((i) => i.id === 'workflow-task:t2')).toBe(false)
    expect(items.some((i) => i.id === 'workflow-task:t1')).toBe(true)
  })

  it('dedupes employee already covered by proactive session', () => {
    const items = buildHomeLiveItems({
      activeSessions: [
        { session_key: 'proactive:sales:duty:2', title: '值班', status: 'running' },
      ],
      roles: [{ agent_code: 'sales', role_name: '销售' }],
      roleBusyByCode: {
        sales: { busy: true, current_session_key: 'proactive:sales:duty:2' },
      },
      automations: [],
      tasks: [],
      ...helpers,
    })
    expect(items.filter((i) => i.kind === 'employee')).toHaveLength(1)
  })
})
