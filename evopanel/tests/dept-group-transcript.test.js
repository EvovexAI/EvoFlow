import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  DEPT_CHAT_LS_PREFIX,
  STREAMING_STALE_MS,
  buildDeptGroupContentJson,
  dedupeMirroredReplies,
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


describe('dedupeMirroredReplies（后端镜像 vs 前端气泡，最多一条）', () => {
  const ts = 1_700_000_000_000
  const fe = {
    id: 'agent-tech-director-1700000000000',
    kind: 'agent',
    agentCode: 'tech-director',
    agentName: '技术总监',
    text: '这轮做完的结论',
    ts,
  }
  const mirror = {
    id: 'dept-reply-abc123',
    kind: 'agent',
    agentCode: 'tech-director',
    agentName: '技术总监',
    text: '这轮做完的结论',
    ts: ts + 1200,
  }

  it('同人同文 10 分钟内重复 → 只留一条，且保留前端那条', () => {
    const out = dedupeMirroredReplies([fe, mirror])
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe(fe.id)
  })

  it('镜像先到时，前端那条照样胜出（替换而不是丢弃信息更全的）', () => {
    const out = dedupeMirroredReplies([mirror, fe])
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe(fe.id)
  })

  it('只有镜像一条（前端断线）→ 必须保留，不能被去重吃掉', () => {
    const out = dedupeMirroredReplies([mirror])
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe(mirror.id)
  })

  it('不同人说了同样的话 → 两条都留', () => {
    const other = { ...fe, id: 'agent-x-1', agentCode: 'other' }
    expect(dedupeMirroredReplies([fe, other])).toHaveLength(2)
  })

  it('同一人不同内容 → 两条都留', () => {
    const other = { ...fe, id: 'agent-tech-director-2', text: '另一句', ts: ts + 5000 }
    expect(dedupeMirroredReplies([fe, other])).toHaveLength(2)
  })

  it('超出 10 分钟窗口 → 视为两次真实发言，都留', () => {
    const later = { ...mirror, ts: ts + 11 * 60 * 1000 }
    expect(dedupeMirroredReplies([fe, later])).toHaveLength(2)
  })

  it('用户消息与系统消息不参与去重', () => {
    const user = { id: 'msg-1', kind: 'user', text: '这轮做完的结论', ts }
    expect(dedupeMirroredReplies([user, fe, mirror])).toHaveLength(2)
  })

  it('空白归一后相同也算重复（换行/多空格）', () => {
    const spaced = { ...mirror, id: 'dept-reply-b', text: '这轮做完的结论  ' }
    expect(dedupeMirroredReplies([fe, spaced])).toHaveLength(1)
  })

  // 反证：判据只认「镜像 ↔ 前端」这一对，不能把真实重复发言也吃掉。
  it('同一 Agent 两轮都回「收到」（两条都是前端气泡）→ 两条都留', () => {
    const second = { ...fe, id: 'agent-tech-director-1700000009999', ts: ts + 30_000 }
    const out = dedupeMirroredReplies([{ ...fe, text: '收到' }, { ...second, text: '收到' }])
    expect(out).toHaveLength(2)
    expect(out.map((m) => m.id)).toEqual([fe.id, second.id])
  })

  it('两条镜像 id 不同（不同轮次）→ 都留，不误判为同一轮的副本', () => {
    const a = { ...mirror, id: 'dept-reply-aaa' }
    const b = { ...mirror, id: 'dept-reply-bbb', ts: ts + 60_000 }
    expect(dedupeMirroredReplies([a, b])).toHaveLength(2)
  })

  it('前端那条后到 → 原位替换镜像，时间顺序不被打乱', () => {
    const mid = { ...fe, id: 'agent-x-1', text: '中间的', ts: ts + 60_000 }
    const out = dedupeMirroredReplies([mirror, mid, fe])
    expect(out.map((m) => m.id)).toEqual([fe.id, mid.id])
  })

  // 现网实测：前端占位行（正文空、streaming）比镜像晚 19 秒落库 → 群里多一个空壳。
  it('幽灵占位行（空正文 streaming + 同人同窗已有真实镜像回复）→ 被过滤', () => {
    const ghost = {
      id: 'agent-tech-director-1700000002500',
      kind: 'agent',
      agentCode: 'tech-director',
      agentName: '技术总监',
      text: '',
      ts: ts + 19_000,
      streaming: true,
    }
    const out = dedupeMirroredReplies([mirror, ghost])
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe(mirror.id)
  })

  // 反证（现网真样本）：幽灵行 created_at 是裸 UTC 串，按本地解析差 8 小时，
  // 只按 ts 比窗口永远抓不到 → 必须用 id 末段的毫秒。
  it('幽灵行时间戳被时区写偏 8 小时（现网真样本）→ 仍按 id 毫秒认出来', () => {
    // 基准时间必须写死：这条用例的判据是「id 毫秒 vs ts 相差 8 小时」，
    // 若镜像那侧用 Date.now()，随墙上时间推移会漂出 10 分钟窗口 → 用例自己先烂掉
    // （本轮实测：08:20 跑是绿的，08:40 跑就红了，因为差 28 分钟）。
    const base = Date.parse('2026-11-20T08:11:41.753+08:00')
    const ghostAt = base + 19_000 // 现网：占位行比镜像晚 19 秒落库
    const realMirror = {
      id: 'dept-reply-64abb950569b8f9e29bc', // 镜像 id 无可解析毫秒 → 回退 m.ts
      kind: 'agent',
      agentCode: 'atmosphere-newfan-bot',
      text: '今晚我盯的是刚入坑这一拨',
      ts: base,
    }
    const ghost = {
      id: `agent-atmosphere-newfan-bot-${ghostAt}`,
      kind: 'agent',
      agentCode: 'atmosphere-newfan-bot',
      text: '',
      // created_at 是裸 UTC 串，被本地时区解析后整体偏早 8 小时
      ts: ghostAt - 8 * 3600 * 1000,
      streaming: true,
    }
    const out = dedupeMirroredReplies([realMirror, ghost])
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe(realMirror.id)
  })

  it('空正文 streaming 但没有任何真实回复 → 必须保留（正在流式中）', () => {
    const inflight = {
      id: `agent-tech-director-${Date.now()}`,
      kind: 'agent',
      agentCode: 'tech-director',
      text: '',
      ts: Date.now(),
      streaming: true,
    }
    expect(dedupeMirroredReplies([inflight])).toHaveLength(1)
  })

  it('同人新一轮的活占位不能被上一轮的镜像回复误删', () => {
    const now = Date.now()
    const oldMirror = {
      id: 'dept-reply-old',
      kind: 'agent',
      agentCode: 'tech-director',
      text: '上一轮的回复',
      ts: now - 9 * 60 * 1000,
    }
    const liveNew = {
      id: `agent-tech-director-${now}`,
      kind: 'agent',
      agentCode: 'tech-director',
      text: '',
      ts: now,
      streaming: true,
    }
    const out = dedupeMirroredReplies([oldMirror, liveNew])
    expect(out).toHaveLength(2)
  })

  it('空正文占位属于别的发言人 → 不因他人有回复而被吃掉', () => {
    const ghost = {
      id: 'agent-other-1',
      kind: 'agent',
      agentCode: 'other',
      text: '',
      ts: ts + 19_000,
      streaming: true,
    }
    expect(dedupeMirroredReplies([mirror, ghost])).toHaveLength(2)
  })
})
