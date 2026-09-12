import { describe, it, expect } from 'vitest'
import {
  computeBadgeCount,
  greetingByHour,
  buildAttentionItems,
  detectChatIntent,
  mapAgentWorkStatus,
} from '../src/components/global-assistant/assistant-rules.js'
import { extractPageContext, shouldHideAssistant } from '../src/components/global-assistant/assistant-context.js'
import { buildEmployeeThreadFromTasks } from '../src/components/global-assistant/assistant-api.js'
import {
  aguiAssistantTextPiece,
  contentToPlainText,
  msgText,
  payloadAssistantText,
  stripInjectedPageContext,
} from '../src/components/global-assistant/assistant-session.js'

describe('xiaomi assistant rules', () => {
  it('computes badge from actionable counts only', () => {
    expect(
      computeBadgeCount({
        approvals: 2,
        waitingUser: 1,
        blocked: 1,
        failed: 0,
        completedUnread: 0,
      }),
    ).toBe(4)
    expect(computeBadgeCount({})).toBe(0)
  })

  it('greets by hour', () => {
    expect(greetingByHour(new Date('2026-07-21T09:00:00'))).toBe('早上好')
    expect(greetingByHour(new Date('2026-07-21T15:00:00'))).toBe('下午好')
    expect(greetingByHour(new Date('2026-07-21T21:00:00'))).toBe('晚上好')
  })

  it('builds attention with approvals first', () => {
    const items = buildAttentionItems(
      [{ id: 'T1', name: '失败任务', status: 'failed', assigned_role: '前端' }],
      [{ id: 'A1', status: 'pending', title: '要拍板', role_name: '产品' }],
      { limit: 4 },
    )
    expect(items[0].kind).toBe('approval_required')
    expect(items.some((x) => x.kind === 'task_failed')).toBe(true)
  })

  it('detects chat intents', () => {
    expect(detectChatIntent('把验收交给测试员工')).toBe('delegate')
    expect(detectChatIntent('知识库里为什么选 MCP')).toBe('knowledge')
    expect(detectChatIntent('有哪些待我审批')).toBe('approvals')
  })

  it('maps agent work status', () => {
    expect(mapAgentWorkStatus('active', true)).toBe('working')
    expect(mapAgentWorkStatus('paused', false)).toBe('offline')
    expect(mapAgentWorkStatus('executing', false)).toBe('working')
  })
})

describe('xiaomi page context', () => {
  it('extracts task / agent / knowledge routes', () => {
    expect(extractPageContext('/task/Task_abc').contextType).toBe('task')
    expect(extractPageContext('/proactive/code-agent').contextType).toBe('agent')
    expect(extractPageContext('/proactive/code-agent').contextId).toBe('code-agent')
    expect(extractPageContext('/knowledge/vaults').contextType).toBe('knowledge_note')
    expect(extractPageContext('/settings').contextType).toBe('settings')
  })

  it('hides on login routes', () => {
    expect(shouldHideAssistant('/login')).toBe(true)
    expect(shouldHideAssistant('/qr-login')).toBe(true)
    expect(shouldHideAssistant('/chat')).toBe(false)
    expect(shouldHideAssistant('/proactive')).toBe(false)
  })
})

describe('xiaomi stream / history text extract', () => {
  it('reads wire message.content blocks (not String(message))', () => {
    expect(
      payloadAssistantText({
        state: 'final',
        message: { role: 'assistant', content: [{ type: 'text', text: '你好，我是小V' }] },
      }),
    ).toBe('你好，我是小V')
    expect(
      payloadAssistantText({
        state: 'delta',
        message: { role: 'assistant', content: [{ type: 'text', text: '增量' }] },
      }),
    ).toBe('增量')
  })

  it('never returns [object Object] for object payloads', () => {
    const bad = payloadAssistantText({
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    })
    expect(bad).not.toContain('[object Object]')
    expect(contentToPlainText({ nested: true })).toBe('')
    expect(msgText({ role: 'assistant', message: { content: [{ type: 'text', text: '历史' }] } })).toBe(
      '历史',
    )
  })

  it('reads contentJson from history rows', () => {
    expect(
      msgText({
        role: 'assistant',
        contentJson: { content: [{ type: 'text', text: '来自库' }] },
      }),
    ).toBe('来自库')
  })

  it('reads AG-UI TEXT_MESSAGE_CONTENT delta pieces', () => {
    expect(
      aguiAssistantTextPiece({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '流' }),
    ).toBe('流')
    expect(aguiAssistantTextPiece({ type: 'TOOL_CALL_START', toolCallId: 't1' })).toBe('')
    expect(aguiAssistantTextPiece({ type: 'RUN_FINISHED' })).toBe('')
  })
})

describe('xiaomi strip page context from bubble', () => {
  it('removes legacy injected system context suffix', () => {
    expect(
      stripInjectedPageContext(
        '你好啊\n\n（系统上下文，仅供理解指代：contextType=workspace contextId=proactive）',
      ),
    ).toBe('你好啊')
  })
})

describe('employee thread from tasks', () => {
  it('splits open progress vs recent/history reports for one agent', () => {
    const today = new Date()
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')} 15:00:00`
    const { openTasks, recentReports, historyReports, reports } = buildEmployeeThreadFromTasks(
      [
        {
          id: '1',
          name: '改登录',
          status: 'executing',
          assigned_to: 'code-agent',
          progress: 40,
          progress_summary: '写测试',
          updated_at: todayIso,
        },
        {
          id: '2',
          name: '今日报告',
          status: 'completed',
          assigned_to: 'code-agent',
          summary: '已合并',
          updated_at: todayIso,
        },
        {
          id: '2b',
          name: '旧报告',
          status: 'completed',
          assigned_to: 'code-agent',
          summary: '很久以前',
          updated_at: '2026-01-01 10:00:00',
        },
        {
          id: '3',
          name: '别人的单',
          status: 'executing',
          assigned_to: 'other',
        },
        {
          id: '4',
          name: '角色名匹配',
          status: 'blocked',
          assigned_role: '代码助手',
          progress: 10,
        },
      ],
      'code-agent',
      { roleName: '代码助手' },
    )
    expect(openTasks.map((t) => t.id).sort()).toEqual(['1', '4'])
    expect(recentReports.map((t) => t.id)).toEqual(['2'])
    expect(historyReports.map((t) => t.id)).toEqual(['2b'])
    expect(reports).toEqual(recentReports)
    expect(openTasks.find((t) => t.id === '1')?.progress).toBe(40)
  })

  it('keeps newest completed at the bottom', () => {
    const today = new Date()
    const y = today.getFullYear()
    const m = String(today.getMonth() + 1).padStart(2, '0')
    const d = String(today.getDate()).padStart(2, '0')
    const { recentReports } = buildEmployeeThreadFromTasks(
      [
        {
          id: 'old',
          name: '早些',
          status: 'completed',
          assigned_to: 'code-agent',
          summary: '早',
          updated_at: `${y}-${m}-${d} 09:00:00`,
        },
        {
          id: 'new',
          name: '刚完成',
          status: 'completed',
          assigned_to: 'code-agent',
          summary: '新',
          updated_at: `${y}-${m}-${d} 18:00:00`,
        },
      ],
      'code-agent',
    )
    expect(recentReports.map((t) => t.id)).toEqual(['old', 'new'])
  })
})