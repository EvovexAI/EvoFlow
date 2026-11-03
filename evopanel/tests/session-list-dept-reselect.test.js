import { describe, expect, it } from 'vitest'
import { resolveSessionReselectAfterRefresh } from '../src/react/lib/session-list/utils.ts'

describe('resolveSessionReselectAfterRefresh · dept chat', () => {
  it('keeps synthetic dept:{id}:chat selection (not in sessions list)', () => {
    const deptKey = 'dept:eng-1:chat'
    const action = resolveSessionReselectAfterRefresh({
      mergedSessions: [
        { sessionKey: 'thread-abc', title: '普通会话' },
      ],
      currentSessionKey: deptKey,
      selectedBeforeAwait: deptKey,
      selectedAfterAwait: deptKey,
      pendingNewAtStart: false,
      preferHomeDraft: false,
      refreshId: 'test-dept',
    })
    expect(action).toEqual({ type: 'none', reason: 'dept-chat-surface' })
  })

  it('does not first-selectable away from dept key when preferHome was on', () => {
    const deptKey = 'dept:sales:chat'
    const action = resolveSessionReselectAfterRefresh({
      mergedSessions: [
        { sessionKey: 'thread-xyz', title: '其它' },
      ],
      currentSessionKey: deptKey,
      selectedBeforeAwait: '',
      selectedAfterAwait: deptKey,
      pendingNewAtStart: false,
      preferHomeDraft: false,
      refreshId: 'test-dept-from-home',
    })
    expect(action.type).toBe('none')
    expect(action.reason).toBe('dept-chat-surface')
  })
})
