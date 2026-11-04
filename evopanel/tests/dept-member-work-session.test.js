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
import {
  extractHistoryAssistantText,
  loadLatestDeptMemberReply,
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
})
