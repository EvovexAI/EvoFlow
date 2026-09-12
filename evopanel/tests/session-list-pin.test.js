import { describe, it, expect, beforeEach } from 'vitest'
import {
  clearSessionPinPending,
  markSessionPinPending,
  resolveMergedSessionPin,
} from '../src/react/lib/session-list/session-pin-pending.js'
import { mergeSessionsFromApi } from '../src/react/lib/session-list/utils.js'

const SESSION_DELETE_TOMBSTONE_KEY = 'evoflow-chat-deleted-session-keys-v1'

describe('session pin pending merge', () => {
  beforeEach(() => {
    clearSessionPinPending('agent:main:abc')
    clearSessionPinPending('agent:main:other')
    localStorage.removeItem(SESSION_DELETE_TOMBSTONE_KEY)
  })

  it('resolveMergedSessionPin trusts API when no pending mutation', () => {
    expect(resolveMergedSessionPin('agent:main:abc', true)).toBe(true)
    expect(resolveMergedSessionPin('agent:main:abc', false)).toBe(false)
  })

  it('resolveMergedSessionPin keeps pending pin until API confirms', () => {
    markSessionPinPending('agent:main:abc', true)
    expect(resolveMergedSessionPin('agent:main:abc', false)).toBe(true)
    expect(resolveMergedSessionPin('agent:main:abc', true)).toBe(true)
    expect(resolveMergedSessionPin('agent:main:abc', true)).toBe(true)
  })

  it('resolveMergedSessionPin keeps pending unpin until API confirms', () => {
    markSessionPinPending('agent:main:abc', false)
    expect(resolveMergedSessionPin('agent:main:abc', true)).toBe(false)
    expect(resolveMergedSessionPin('agent:main:abc', false)).toBe(false)
  })

  it('mergeSessionsFromApi preserves pin during stale refresh', () => {
    markSessionPinPending('agent:main:abc', true)
    const prev = [
      {
        sessionKey: 'agent:main:abc',
        title: 'Pinned chat',
        isPinned: true,
        pinOrder: 2,
        createdAt: 1000,
        updatedAt: 1000,
      },
    ]
    const apiRows = [
      {
        sessionKey: 'agent:main:abc',
        title: 'Pinned chat',
        isPinned: false,
        pinOrder: 0,
        createdAt: 1000,
        updatedAt: 1000,
      },
    ]
    const merged = mergeSessionsFromApi(prev, apiRows, 'agent:main:abc')
    expect(merged.find((s) => s.sessionKey === 'agent:main:abc')?.isPinned).toBe(true)
    expect(merged.find((s) => s.sessionKey === 'agent:main:abc')?.pinOrder).toBe(2)
  })

  it('mergeSessionsFromApi drops tombstoned deleted sessions from prev and api', () => {
    localStorage.setItem(
      SESSION_DELETE_TOMBSTONE_KEY,
      JSON.stringify(['agent:main:deleted', 'agent:main:ghost']),
    )
    const prev = [
      {
        sessionKey: 'agent:main:ghost',
        title: 'ghost draft',
        createdAt: 1000,
        updatedAt: 1000,
      },
    ]
    const apiRows = [
      {
        sessionKey: 'agent:main:deleted',
        title: 'should not return',
        createdAt: 2000,
        updatedAt: 2000,
      },
      {
        sessionKey: 'agent:main:live',
        title: 'live',
        createdAt: 3000,
        updatedAt: 3000,
      },
    ]
    const merged = mergeSessionsFromApi(prev, apiRows, '')
    expect(merged.map((s) => s.sessionKey)).toEqual(['agent:main:live'])
  })

  it('mergeSessionsFromApi keeps local terminal status over stale API running', () => {
    const prev = [
      {
        sessionKey: 'agent:main:done',
        title: 'Done chat',
        runStatus: 'done',
        currentRunId: null,
        currentTurnStartedAt: '2026-09-08T08:00:00.000Z',
        currentTurnEndedAt: '2026-09-08T08:00:05.000Z',
        createdAt: 1000,
        updatedAt: 2000,
      },
    ]
    const apiRows = [
      {
        sessionKey: 'agent:main:done',
        title: 'Done chat',
        runStatus: 'running',
        currentRunId: 'stale-run',
        currentTurnStartedAt: '2026-09-08T08:00:00.000Z',
        currentTurnEndedAt: null,
        createdAt: 1000,
        updatedAt: 2000,
      },
    ]
    const merged = mergeSessionsFromApi(prev, apiRows, 'agent:main:done')
    const row = merged.find((s) => s.sessionKey === 'agent:main:done')
    expect(row?.runStatus).toBe('done')
    expect(row?.currentRunId).toBeNull()
    expect(row?.currentTurnEndedAt).toBe('2026-09-08T08:00:05.000Z')
  })
})
