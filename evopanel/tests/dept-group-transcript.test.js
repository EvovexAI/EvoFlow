import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  DEPT_CHAT_LS_PREFIX,
  STREAMING_STALE_MS,
  buildDeptGroupContentJson,
  mapApiRowToDeptGroupMsg,
  migrateLocalDeptChatIfNeeded,
  staleStreamingToError,
  workSessionKeyForSpeaker,
} from '../src/react/lib/dept-group-transcript.ts'

vi.mock('../src/lib/tauri-api.js', () => {
  const chatHistory = vi.fn()
  const chatSessionsCreate = vi.fn(async () => ({}))
  const chatUpdateContext = vi.fn(async () => ({}))
  const gatewayProxy = vi.fn(async () => ({ ok: true }))
  return {
    api: { chatHistory, chatSessionsCreate, chatUpdateContext },
    gatewayProxy,
  }
})

import { api, gatewayProxy } from '../src/lib/tauri-api.js'

describe('dept-group-transcript mapping', () => {
  it('builds content_json with work_session_key and wake_job_id', () => {
    const json = buildDeptGroupContentJson(
      {
        id: 'agent-1',
        kind: 'agent',
        agentCode: 'dev-a',
        agentName: '全栈工程师',
        text: '收到',
        ts: 1,
        workSessionKey: 'proactive:dev-a:chat:dept-rd',
        wakeJobId: 'job-9',
      },
      { deptId: 'rd', deptName: '研发部', streamState: 'final' },
    )
    expect(json.content).toBe('收到')
    expect(json.dept_group).toMatchObject({
      dept_id: 'rd',
      dept_name: '研发部',
      msg_kind: 'agent',
      speaker_code: 'dev-a',
      speaker_name: '全栈工程师',
      work_session_key: 'proactive:dev-a:chat:dept-rd',
      wake_job_id: 'job-9',
      stream_state: 'final',
    })
  })

  it('maps API row via dept_group meta', () => {
    const msg = mapApiRowToDeptGroupMsg({
      message_id: 'bubble-1',
      role: 'assistant',
      created_at_ms: 1700000000000,
      content_json: {
        content: '在群里回复',
        dept_group: {
          msg_kind: 'agent',
          speaker_code: 'dev-a',
          speaker_name: '全栈',
          work_session_key: 'proactive:dev-a:chat:dept-rd',
          wake_job_id: 'wj-1',
          stream_state: 'final',
        },
      },
    })
    expect(msg).toMatchObject({
      id: 'bubble-1',
      kind: 'agent',
      agentCode: 'dev-a',
      agentName: '全栈',
      text: '在群里回复',
      workSessionKey: 'proactive:dev-a:chat:dept-rd',
      wakeJobId: 'wj-1',
      streaming: false,
      error: false,
    })
  })

  it('maps system tool rows', () => {
    const msg = mapApiRowToDeptGroupMsg({
      message_id: 'sys-1',
      role: 'user',
      tool_name: 'dept_group_system',
      content_json: {
        content: '已流转',
        dept_group: { msg_kind: 'system', stream_state: 'final' },
      },
    })
    expect(msg?.kind).toBe('system')
    expect(msg?.text).toBe('已流转')
  })

  it('marks stale streaming as error', () => {
    const now = 1_000_000
    const fresh = {
      id: 'a',
      kind: 'agent',
      text: '',
      ts: now - 60_000,
      streaming: true,
    }
    const stale = {
      id: 'b',
      kind: 'agent',
      text: '',
      ts: now - STREAMING_STALE_MS - 1,
      streaming: true,
    }
    const out = staleStreamingToError([fresh, stale], { now }) // opts object
    expect(out[0].streaming).toBe(true)
    expect(out[1]).toMatchObject({
      streaming: false,
      error: true,
      text: '（回复未完成）',
    })
  })

  it('builds work session key for speaker', () => {
    expect(workSessionKeyForSpeaker('rd', 'dev-a')).toBe(
      'proactive:dev-a:chat:dept-rd',
    )
  })
})

describe('dept-group-transcript migrate', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    api.chatHistory.mockResolvedValue({ messages: [] })
    api.chatSessionsCreate.mockResolvedValue({})
    api.chatUpdateContext.mockResolvedValue({})
    gatewayProxy.mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('imports localStorage when DB empty then clears LS', async () => {
    const deptId = 'rd'
    localStorage.setItem(
      `${DEPT_CHAT_LS_PREFIX}${deptId}`,
      JSON.stringify([
        { id: 'user-1', kind: 'user', text: 'hello', ts: 1 },
        { id: 'agent-1', kind: 'agent', agentCode: 'a', text: 'hi', ts: 2 },
        { id: 'skip', kind: 'agent', text: '', ts: 3, streaming: true },
      ]),
    )
    api.chatHistory
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({
        messages: [
          {
            message_id: 'user-1',
            role: 'user',
            created_at_ms: 1,
            content_json: {
              content: 'hello',
              dept_group: { msg_kind: 'user', stream_state: 'final' },
            },
          },
          {
            message_id: 'agent-1',
            role: 'assistant',
            created_at_ms: 2,
            content_json: {
              content: 'hi',
              dept_group: {
                msg_kind: 'agent',
                speaker_code: 'a',
                stream_state: 'final',
              },
            },
          },
        ],
      })

    const rows = await migrateLocalDeptChatIfNeeded({
      deptId,
      deptName: '研发部',
    })

    expect(gatewayProxy).toHaveBeenCalled()
    const posts = gatewayProxy.mock.calls.filter(
      (c) => c[0] === 'POST' && String(c[1]).includes('/messages'),
    )
    expect(posts.length).toBe(2)
    expect(localStorage.getItem(`${DEPT_CHAT_LS_PREFIX}${deptId}`)).toBeNull()
    expect(rows.map((r) => r.id)).toEqual(['user-1', 'agent-1'])
  })

  it('skips LS when DB already has messages', async () => {
    const deptId = 'rd'
    localStorage.setItem(
      `${DEPT_CHAT_LS_PREFIX}${deptId}`,
      JSON.stringify([{ id: 'old', kind: 'user', text: 'legacy', ts: 1 }]),
    )
    api.chatHistory.mockResolvedValue({
      messages: [
        {
          message_id: 'db-1',
          role: 'user',
          created_at_ms: 9,
          content_json: {
            content: 'from-db',
            dept_group: { msg_kind: 'user', stream_state: 'final' },
          },
        },
      ],
    })

    const rows = await migrateLocalDeptChatIfNeeded({ deptId, deptName: '研发' })
    expect(gatewayProxy).not.toHaveBeenCalled()
    expect(rows).toHaveLength(1)
    expect(rows[0].text).toBe('from-db')
    // 32655cae：DB 已有权威副本时跳过 LS 导入，且会清掉可能过期的 LS 备份
    expect(localStorage.getItem(`${DEPT_CHAT_LS_PREFIX}${deptId}`)).toBeNull()
  })
})
