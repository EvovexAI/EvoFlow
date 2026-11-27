import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { resolveSessionReselectAfterRefresh } from '../src/react/lib/session-list/utils.ts'

describe('resolveSessionReselectAfterRefresh · dept chat', () => {
  const mem = new Map()
  beforeEach(() => {
    mem.clear()
    globalThis.localStorage = {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => {
        mem.set(k, String(v))
      },
      removeItem: (k) => {
        mem.delete(k)
      },
    }
    globalThis.sessionStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    }
  })
  afterEach(() => {
    mem.clear()
  })

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

  it('never first-selectables a dept:{id}:chat row', () => {
    const action = resolveSessionReselectAfterRefresh({
      mergedSessions: [
        { sessionKey: 'dept:first:chat', title: '第一群' },
        { sessionKey: 'proactive:bot:chat:1', title: '员工' },
        { sessionKey: 'thread-xyz', title: '其它' },
      ],
      currentSessionKey: '',
      selectedBeforeAwait: '',
      selectedAfterAwait: '',
      pendingNewAtStart: false,
      preferHomeDraft: false,
      refreshId: 'test-no-dept-first',
    })
    expect(action).toEqual({
      type: 'select',
      sessionKey: 'proactive:bot:chat:1',
      reason: 'first-selectable',
    })
  })

  it('prefers last employee session from storage over empty selection', () => {
    mem.set('evopanel_last_employee_session', 'proactive:ops:chat:keep')
    mem.set('evopanel_last_selected_session', 'dept:first:chat')
    const action = resolveSessionReselectAfterRefresh({
      mergedSessions: [
        { sessionKey: 'dept:first:chat', title: '第一群' },
        { sessionKey: 'thread-xyz', title: '其它' },
      ],
      currentSessionKey: '',
      selectedBeforeAwait: '',
      selectedAfterAwait: '',
      pendingNewAtStart: false,
      preferHomeDraft: false,
      refreshId: 'test-last-employee',
    })
    expect(action).toEqual({
      type: 'select',
      sessionKey: 'proactive:ops:chat:keep',
      reason: 'last-selected-storage',
    })
  })
})
