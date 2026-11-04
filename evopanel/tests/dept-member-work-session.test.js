import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../src/lib/tauri-api.js', () => {
  const chatHistory = vi.fn()
  const chatSessionsCreate = vi.fn(async () => ({}))
  const chatSend = vi.fn(async () => ({}))
  return {
    api: { chatHistory, chatSessionsCreate, chatSend },
  }
})

vi.mock('../src/lib/ws-client.js', () => ({
  wsClient: {
    updateSessionContext: vi.fn(async () => {}),
    onEvent: vi.fn(() => () => {}),
  },
}))

import { api } from '../src/lib/tauri-api.js'
import { wsClient } from '../src/lib/ws-client.js'
import {
  extractHistoryAssistantText,
  loadLatestDeptMemberReply,
  runDeptMemberWorkTurn,
} from '../src/react/lib/dept-member-work-session.ts'

describe('dept-member-work-session history extract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads assistant text from content_json.content', () => {
    expect(
      extractHistoryAssistantText({
        role: 'assistant',
        content: '',
        content_json: { content: '群里直接回复进度' },
      }),
    ).toBe('群里直接回复进度')
  })

  it('skips non-assistant rows', () => {
    expect(
      extractHistoryAssistantText({
        role: 'user',
        content: 'hello',
      }),
    ).toBe('')
  })

  it('loadLatestDeptMemberReply picks newest assistant', async () => {
    api.chatHistory.mockResolvedValue({
      messages: [
        { role: 'user', content: 'ping' },
        { role: 'assistant', content_json: { content: '旧回复' } },
        { role: 'assistant', content: '最新回复' },
      ],
    })
    await expect(loadLatestDeptMemberReply('proactive:a:chat:dept-x')).resolves.toBe(
      '最新回复',
    )
  })

  it('steward turn keeps rules/roster in session ctx; user text is slim', async () => {
    api.chatSessionsCreate.mockResolvedValue({})
    api.chatSend.mockResolvedValue({})
    wsClient.onEvent.mockReturnValue(() => {})
    wsClient.updateSessionContext.mockResolvedValue({})

    await runDeptMemberWorkTurn({
      deptId: 'rd',
      deptName: '研发部',
      agentCode: 'xiaomi',
      roleName: '小V',
      text: '群里有谁啊',
      groupContext: '用户：哈喽\n小V：收到',
      stewardMode: true,
      roster: [
        { agent_code: 'cto', role_name: '技术总监' },
        { agent_code: 'qa', role_name: '测试工程师' },
      ],
    })

    const ctx = api.chatSessionsCreate.mock.calls[0][1].context
    expect(ctx.dept_group_im).toBe(true)
    expect(ctx.dept_group_steward).toBe(true)
    expect(ctx.dept_group_roster).toEqual(['技术总监', '测试工程师'])

    const userText = api.chatSend.mock.calls[0][1]
    expect(userText).toContain('【群近期】')
    expect(userText).toContain('用户：哈喽')
    expect(userText).toContain('【用户对群说（未点名，请你接住）】')
    expect(userText).toContain('群里有谁啊')
    expect(userText).not.toContain('硬规则')
    expect(userText).not.toContain('本群可点名')
    expect(userText).not.toContain('禁止 Markdown')
  })
})
