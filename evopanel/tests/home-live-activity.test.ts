import { describe, expect, it } from 'vitest'
import { buildHomeLiveItems, HOME_LIVE_STALE_MS } from '../src/react/lib/home-live-activity.js'

describe('buildHomeLiveItems', () => {
  const nowMs = Date.parse('2026-10-25T12:00:00+08:00')
  const freshIso = new Date(nowMs - 60_000).toISOString()
  const staleIso = new Date(nowMs - HOME_LIVE_STALE_MS - 60_000).toISOString()

  const helpers = {
    isTaskRunning: (status: unknown) => {
      const s = String(status || '').toLowerCase()
      return s === 'executing' || s === 'running' || s === 'planning'
    },
    taskSourceKey: (t: any) => String(t?.source || 'other'),
    taskTitle: (t: any) => String(t?.name || t?.title || 'task'),
    taskHref: (t: any) => `#/task/${t.id}`,
    formatTaskSourceZh: (src: unknown) => (src === 'workflow' ? '工作流' : String(src || '')),
    nowMs,
  }

  it('classifies chat / employee / automation sessions and live workflow tasks', () => {
    const items = buildHomeLiveItems({
      activeSessions: {
        active_sessions: [
          {
            session_key: 'agent:main:abc',
            title: '写周报',
            agent_id: 'main',
            status: 'running',
            updated_at: freshIso,
            thread_id: 'thread-wf-1',
            collab_task_id: 't1',
          },
          {
            session_key: 'proactive:sales:duty:1',
            title: '销售 · 值班',
            agent_id: 'sales',
            status: 'running',
            updated_at: freshIso,
          },
          {
            session_key: 'automation:cron-1:run-9',
            title: '',
            status: 'pending',
            updated_at: freshIso,
          },
        ],
      },
      roles: [{ agent_code: 'sales', role_name: '销售助手' }],
      roleBusyByCode: {
        ops: { busy: true, current_session_key: '' },
      },
      automations: [{ id: 'cron-1', name: '每日巡检' }],
      tasks: [
        {
          id: 't1',
          name: '发版流程',
          source: 'workflow',
          status: 'executing',
          thread_id: 'thread-wf-1',
          updated_at: freshIso,
        },
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
        {
          session_key: 'proactive:sales:duty:2',
          title: '值班',
          status: 'running',
          updated_at: freshIso,
        },
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

  it('drops stale sessions and workflow tasks with no live session join', () => {
    const items = buildHomeLiveItems({
      activeSessions: [
        {
          session_key: 'agent:main:zombie',
          title: '节点执行记录',
          agent_id: 'executor',
          status: 'running',
          updated_at: staleIso,
        },
        {
          session_key: 'agent:main:live',
          title: '刚发的消息',
          agent_id: 'main',
          status: 'running',
          updated_at: freshIso,
        },
      ],
      roles: [],
      roleBusyByCode: {},
      automations: [],
      tasks: [
        {
          id: 'wf-zombie',
          name: 'demo-1007·商品短视频脚本',
          source: 'workflow',
          status: 'executing',
          updated_at: staleIso,
        },
        {
          id: 'wf-no-session',
          name: '童话故事生成器',
          source: 'workflow',
          status: 'executing',
          updated_at: freshIso,
        },
      ],
      ...helpers,
    })

    expect(items.map((i) => i.title)).toEqual(['刚发的消息'])
    expect(items.every((i) => i.statusLabel === '在跑')).toBe(true)
  })

  it('hides epoch / junk timestamps in the time column', () => {
    const items = buildHomeLiveItems({
      activeSessions: [
        {
          session_key: 'agent:main:x',
          title: 'ok',
          status: 'running',
          updated_at: freshIso,
        },
      ],
      roles: [],
      roleBusyByCode: {},
      automations: [],
      tasks: [],
      ...helpers,
    })
    expect(items[0]?.time).not.toBe('00:00')
  })
})
