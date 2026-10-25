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
})
