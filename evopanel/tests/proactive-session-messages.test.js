import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import {
  buildProactiveDutySessionKey,
  buildProactiveTaskSessionKey,
  pickProactiveConversationSessionKey,
  resolveProactiveProcessMeta,
  sanitizeProactiveSessionSuffix,
} from '../src/lib/proactive-session-messages.js'

describe('proactive session message keys', () => {
  it('sanitizes round stamps like backend', () => {
    assert.equal(
      sanitizeProactiveSessionSuffix('round:2026-07-16T04:00:00Z'),
      'round-2026-07-16T04-00-00Z',
    )
  })

  it('builds task and duty session keys', () => {
    assert.equal(
      buildProactiveTaskSessionKey('ops-bot', '2607160040_abcd'),
      'proactive:ops-bot:task:2607160040_abcd',
    )
    assert.equal(
      buildProactiveDutySessionKey('ops-bot', 'round:2026-07-16T04:00:00Z'),
      'proactive:ops-bot:duty:round-2026-07-16T04-00-00Z',
    )
  })

  it('picks task conversation over duty when taskId matches', () => {
    const sk = pickProactiveConversationSessionKey(
      [
        { kind: 'duty', session_key: 'proactive:ops-bot:duty:round-1' },
        { kind: 'task', session_key: 'proactive:ops-bot:task:t1', task_id: 't1' },
      ],
      { taskId: 't1' },
    )
    assert.equal(sk, 'proactive:ops-bot:task:t1')
  })

  it('prefers running conversation when no task/round match', () => {
    const sk = pickProactiveConversationSessionKey(
      [
        { kind: 'duty', session_key: 'proactive:ops-bot:duty:old' },
        { kind: 'chat', session_key: 'proactive:ops-bot:chat:live', run_status: 'running' },
      ],
      {},
    )
    assert.equal(sk, 'proactive:ops-bot:chat:live')
  })

  it('resolveProactiveProcessMeta picks thread_id from conversations', async () => {
    const { api } = await import('../src/lib/tauri-api.js')
    const orig = api.proactiveListConversations
    api.proactiveListConversations = async () => ({
      role_name: '运营',
      conversations: [
        {
          kind: 'task',
          session_key: 'proactive:ops-bot:task:t1',
          task_id: 't1',
          thread_id: 'thread-abc',
          run_status: 'running',
        },
      ],
    })
    try {
      const meta = await resolveProactiveProcessMeta({ agentCode: 'ops-bot', taskId: 't1' })
      assert.equal(meta.session_key, 'proactive:ops-bot:task:t1')
      assert.equal(meta.thread_id, 'thread-abc')
      assert.equal(meta.run_status, 'running')
      assert.equal(meta.role_name, '运营')
    } finally {
      api.proactiveListConversations = orig
    }
  })

  it('resolveProactiveProcessMeta pins explicit sessionKey and ignores other done rows', async () => {
    const { api } = await import('../src/lib/tauri-api.js')
    const orig = api.proactiveListConversations
    api.proactiveListConversations = async () => ({
      role_name: '知识库验证员',
      conversations: [
        {
          kind: 'duty',
          session_key: 'proactive:kb-bot:duty:old',
          thread_id: 'thread-old',
          run_status: 'done',
        },
        {
          kind: 'chat',
          session_key: 'proactive:kb-bot:chat:live',
          thread_id: 'thread-live',
          run_status: 'running',
        },
      ],
    })
    try {
      const meta = await resolveProactiveProcessMeta({
        agentCode: 'kb-bot',
        sessionKey: 'proactive:kb-bot:chat:live',
      })
      assert.equal(meta.session_key, 'proactive:kb-bot:chat:live')
      assert.equal(meta.thread_id, 'thread-live')
      assert.equal(meta.run_status, 'running')
    } finally {
      api.proactiveListConversations = orig
    }
  })

  it('resolveProactiveProcessMeta with unknown explicit key keeps empty run_status', async () => {
    const { api } = await import('../src/lib/tauri-api.js')
    const origList = api.proactiveListConversations
    api.proactiveListConversations = async () => ({
      conversations: [
        {
          kind: 'duty',
          session_key: 'proactive:kb-bot:duty:old',
          thread_id: 'thread-old',
          run_status: 'done',
        },
      ],
    })
    try {
      const ensured = []
      const meta = await resolveProactiveProcessMeta({
        agentCode: 'kb-bot',
        sessionKey: 'proactive:kb-bot:chat:new',
        ensureThread: async (sk) => {
          ensured.push(sk)
          return 'thread-new'
        },
      })
      assert.equal(meta.session_key, 'proactive:kb-bot:chat:new')
      assert.equal(meta.thread_id, 'thread-new')
      assert.equal(meta.run_status, '')
      assert.deepEqual(ensured, ['proactive:kb-bot:chat:new'])
    } finally {
      api.proactiveListConversations = origList
    }
  })

  it('resolveProactiveProcessMeta treats live: taskId as empty', async () => {
    const { api } = await import('../src/lib/tauri-api.js')
    const orig = api.proactiveListConversations
    api.proactiveListConversations = async () => ({
      conversations: [
        {
          kind: 'chat',
          session_key: 'proactive:ops-bot:chat:x',
          thread_id: 'thread-x',
          run_status: 'running',
        },
      ],
    })
    try {
      const meta = await resolveProactiveProcessMeta({
        agentCode: 'ops-bot',
        taskId: 'live:ops-bot',
      })
      assert.equal(meta.session_key, 'proactive:ops-bot:chat:x')
      assert.equal(meta.thread_id, 'thread-x')
      assert.equal(meta.run_status, 'running')
    } finally {
      api.proactiveListConversations = orig
    }
  })
})

// 【self-evolution-bot · 2026-11-20 · 第95轮 · 模型:deepseek-v4.1-flash-1017】
// 防串台：同一员工同一时刻只跑一个任务，A 对话派单时它可能正跑着 B 对话派的任务。
// 自动绑定必须拒绝「早于本次派发时刻创建的会话」，否则 A 的右栏会显示 B 的内容。
describe('resolveProactiveProcessMeta 自动绑定不得早于本次派发', () => {
  const mk = (rows) => async () => ({ role_name: '发版工程师', conversations: rows })

  it('唯一在跑的会话早于本次派发 => 不绑定（宁可空着继续轮询）', async () => {
    const { api } = await import('../src/lib/tauri-api.js')
    const orig = api.proactiveListConversations
    // 别人的任务：18:09:19 建（早于本次派发），且正在 running
    api.proactiveListConversations = mk([
      {
        kind: 'task',
        session_key: 'proactive:release-engineer:task:OLD_OTHER',
        task_id: 'OLD_OTHER',
        thread_id: 'thread-old',
        run_status: 'running',
        created_at: '2026-11-20T18:09:19.218000+08:00',
      },
    ])
    try {
      const meta = await resolveProactiveProcessMeta({
        agentCode: 'release-engineer',
        roundId: 'dispatch:2026-11-20T18:20:00.000+08:00',
        autoBindSince: Date.parse('2026-11-20T18:20:00.000+08:00'),
        ensureThread: async () => 'should-not-be-used',
      })
      assert.equal(meta.session_key, '', '不许绑到别人对话派的任务')
      assert.equal(meta.thread_id, '')
    } finally {
      api.proactiveListConversations = orig
    }
  })

  it('本次派发之后创建的会话 => 正常绑定', async () => {
    const { api } = await import('../src/lib/tauri-api.js')
    const orig = api.proactiveListConversations
    api.proactiveListConversations = mk([
      {
        kind: 'task',
        session_key: 'proactive:release-engineer:task:NEW_MINE',
        task_id: 'NEW_MINE',
        thread_id: 'thread-new',
        run_status: 'running',
        created_at: '2026-11-20T18:20:01.000000+08:00',
      },
    ])
    try {
      const meta = await resolveProactiveProcessMeta({
        agentCode: 'release-engineer',
        roundId: 'dispatch:2026-11-20T18:20:00.000+08:00',
        autoBindSince: Date.parse('2026-11-20T18:20:00.000+08:00'),
        ensureThread: async () => '',
      })
      assert.equal(meta.session_key, 'proactive:release-engineer:task:NEW_MINE')
      assert.equal(meta.thread_id, 'thread-new')
    } finally {
      api.proactiveListConversations = orig
    }
  })

  it('闸只在无 hint 时生效：显式 hint 照旧绑定（用户手选的会话不被冲掉）', async () => {
    const { api } = await import('../src/lib/tauri-api.js')
    const orig = api.proactiveListConversations
    api.proactiveListConversations = mk([
      {
        kind: 'chat',
        session_key: 'proactive:release-engineer:chat:2026-11-18T17-31-25.538Z',
        thread_id: 'thread-chat',
        run_status: 'done',
        created_at: '2026-11-18T17:31:25.538Z',
      },
    ])
    try {
      const meta = await resolveProactiveProcessMeta({
        agentCode: 'release-engineer',
        sessionKey: 'proactive:release-engineer:chat:2026-11-18T17-31-25.538Z',
        roundId: 'dispatch:2026-11-20T18:20:00.000Z',
        autoBindSince: Date.parse('2026-11-20T18:20:00.000Z'),
      })
      assert.equal(meta.session_key, 'proactive:release-engineer:chat:2026-11-18T17-31-25.538Z')
    } finally {
      api.proactiveListConversations = orig
    }
  })
})
