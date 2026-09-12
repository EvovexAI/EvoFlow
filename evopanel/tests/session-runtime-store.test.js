import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  bumpSessionRuntimeNotify,
  commitActiveSessionRuntime,
  deriveSessionRecoveryPhase,
  dispatchSessionTurnEvent,
  flushPendingSessionRuntimeNotify,
  getSessionRuntime,
  getSessionRuntimeEpoch,
  getSessionRuntimeEpochForKey,
  getExecutingListRuntimeEpoch,
  hydrateSessionRuntimeRowsIfIdle,
  isSessionRuntimeLive,
  isSessionRuntimeStreamVisible,
  listLiveSessionRuntimeKeys,
  markSessionSending,
  mountSessionRuntime,
  noteSessionEvent,
  recoveryPhaseLabel,
  resetRuntimeStream,
  rowsAlreadyStopSealedForTurn,
  rowsBaseForSend,
  subscribeSessionRuntime,
  subscribeSessionRuntimeForKey,
  subscribeExecutingListRuntime,
  updateSessionRuntimeRows,
} from '../src/react/lib/session-runtime-store.ts'
import { emptyStream } from '../src/react/lib/stream-state.ts'

describe('session-runtime-store notify coalescing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces high-frequency ACTIVITY events per session', () => {
    const epochs = []
    const sk = 'agent:main:notify-coalesce'
    const unsub = subscribeSessionRuntimeForKey(sk, () => {
      epochs.push(getSessionRuntimeEpochForKey(sk))
    })
    dispatchSessionTurnEvent(sk, { type: 'ACTIVITY', kind: 'thinking', detail: 'a' })
    dispatchSessionTurnEvent(sk, { type: 'ACTIVITY', kind: 'thinking', detail: 'b' })
    dispatchSessionTurnEvent(sk, { type: 'ACTIVITY', kind: 'tools', detail: 'c' })
    expect(epochs).toHaveLength(0)
    vi.runAllTimers()
    expect(epochs).toHaveLength(1)
    unsub()
  })

  it('notifies immediately for turn lifecycle events', () => {
    const epochs = []
    const executingEpochs = []
    const unsub = subscribeSessionRuntime(() => {
      epochs.push(getSessionRuntimeEpoch())
    })
    const unsubExec = subscribeExecutingListRuntime(() => {
      executingEpochs.push(getExecutingListRuntimeEpoch())
    })
    const sk = 'agent:main:notify-immediate'
    dispatchSessionTurnEvent(sk, { type: 'SEND_STARTED' })
    expect(epochs).toHaveLength(1)
    expect(executingEpochs).toHaveLength(1)
    dispatchSessionTurnEvent(sk, { type: 'TURN_IDLE' })
    expect(epochs).toHaveLength(2)
    expect(executingEpochs).toHaveLength(2)
    unsub()
    unsubExec()
  })

  it('flushPendingSessionRuntimeNotify drains coalesced bump', () => {
    const epochs = []
    const unsub = subscribeSessionRuntime(() => {
      epochs.push(getSessionRuntimeEpoch())
    })
    bumpSessionRuntimeNotify()
    bumpSessionRuntimeNotify()
    expect(epochs).toHaveLength(0)
    flushPendingSessionRuntimeNotify()
    expect(epochs).toHaveLength(1)
    unsub()
  })

  it('notifies per-session subscribers without global epoch', () => {
    const globalEpochs = []
    const sessionEpochs = []
    const sk = 'agent:main:per-session'
    const unsubGlobal = subscribeSessionRuntime(() => {
      globalEpochs.push(getSessionRuntimeEpoch())
    })
    const unsubSession = subscribeSessionRuntimeForKey(sk, () => {
      sessionEpochs.push(getSessionRuntimeEpochForKey(sk))
    })
    dispatchSessionTurnEvent(sk, { type: 'ACTIVITY', kind: 'thinking', detail: 'a' })
    dispatchSessionTurnEvent(sk, { type: 'ACTIVITY', kind: 'thinking', detail: 'b' })
    expect(globalEpochs).toHaveLength(0)
    expect(sessionEpochs).toHaveLength(0)
    vi.runAllTimers()
    expect(globalEpochs).toHaveLength(0)
    expect(sessionEpochs).toHaveLength(1)
    unsubGlobal()
    unsubSession()
  })

  it('noteSessionEvent silent skips per-session notify', () => {
    const sk = 'agent:main:note-silent'
    const rt = getSessionRuntime(sk)
    const epochs = []
    const unsub = subscribeSessionRuntimeForKey(sk, () => {
      epochs.push(getSessionRuntimeEpochForKey(sk))
    })
    noteSessionEvent(sk, rt, { textPreview: 'bg delta', silent: true })
    vi.runAllTimers()
    expect(epochs).toHaveLength(0)
    expect(rt.lastVisibleTextPreview).toBe('bg delta')
    noteSessionEvent(sk, rt, { textPreview: 'fg delta' })
    vi.runAllTimers()
    expect(epochs).toHaveLength(1)
    unsub()
  })
})

describe('session-runtime-store', () => {
  it('keeps rows and stream on the same session entry', () => {
    const sk = 'agent:main:test-a'
    const streamRef = { current: emptyStream() }
    commitActiveSessionRuntime(sk, {
      rows: [{ role: 'user', text: '哈哈哈', timestamp: 1 }],
      stream: streamRef.current,
      isSending: true,
      seenRunIds: [],
      activeChatRunId: null,
    })
    mountSessionRuntime(sk, {
      streamRef,
      setIsSending: () => {},
      isSendingRef: { current: true },
      seenRunIdsRef: { current: new Set() },
      activeChatRunIdRef: { current: null },
    })
    expect(getSessionRuntime(sk).rows).toHaveLength(1)
    expect(getSessionRuntime(sk).rows[0].text).toBe('哈哈哈')
    expect(isSessionRuntimeLive(getSessionRuntime(sk))).toBe(true)
  })

  it('updates rows in background without losing user message', () => {
    const sk = 'agent:main:test-b'
    const rt = getSessionRuntime(sk)
    rt.rows = [{ role: 'user', text: 'hi', timestamp: 1 }]
    rt.isSending = true
    updateSessionRuntimeRows(sk, (r) => [
      ...r,
      { role: 'assistant', text: 'partial', timestamp: 2 },
    ])
    expect(getSessionRuntime(sk).rows).toHaveLength(2)
    resetRuntimeStream(rt)
    expect(rt.stream.turn).toBeDefined()
  })

  it('rowsBaseForSend prefers visible history when runtime is empty', () => {
    const visible = [
      { role: 'user', text: 'old', timestamp: 1 },
      { role: 'assistant', text: 'reply', timestamp: 2 },
    ]
    expect(rowsBaseForSend([], visible)).toEqual(visible)
    expect(rowsBaseForSend([{ role: 'user', text: 'only new', timestamp: 3 }], visible)).toEqual(visible)
  })

  it('rowsAlreadyStopSealedForTurn scopes to current user turn only', () => {
    const priorStop = [
      { role: 'user', text: 'first', timestamp: 1 },
      { role: 'assistant', text: 'partial', timestamp: 2 },
      { role: 'system', text: '生成已停止', timestamp: 3 },
      { role: 'user', text: 'second', timestamp: 4 },
    ]
    expect(rowsAlreadyStopSealedForTurn(priorStop)).toBe(false)

    const currentStop = [
      ...priorStop,
      { role: 'assistant', text: 'more partial', timestamp: 5 },
      { role: 'system', text: '生成已停止', timestamp: 6 },
    ]
    expect(rowsAlreadyStopSealedForTurn(currentStop)).toBe(true)
  })

  it('hydrateSessionRuntimeRowsIfIdle copies loaded transcript', () => {
    const sk = 'agent:main:test-hydrate'
    const loaded = [
      { role: 'user', text: 'from api', timestamp: 1 },
      { role: 'assistant', text: 'stored', timestamp: 2 },
    ]
    hydrateSessionRuntimeRowsIfIdle(sk, loaded)
    expect(getSessionRuntime(sk).rows).toEqual(loaded)
    hydrateSessionRuntimeRowsIfIdle(sk, [{ role: 'user', text: 'from api', timestamp: 1 }])
    expect(getSessionRuntime(sk).rows).toEqual(loaded)
  })

  it('listLiveSessionRuntimeKeys includes background sending sessions', () => {
    const sk = 'agent:main:test-live-list'
    const rt = getSessionRuntime(sk)
    rt.isSending = true
    expect(listLiveSessionRuntimeKeys()).toContain(sk)
    rt.isSending = false
    expect(listLiveSessionRuntimeKeys()).not.toContain(sk)
  })

  it('markSessionSending(false) clears sidebar preview fields', () => {
    const sk = 'agent:main:test-clear-preview'
    const rt = getSessionRuntime(sk)
    noteSessionEvent(sk, rt, { textPreview: 'partial', toolPreview: 'web_search' })
    markSessionSending(sk, true)
    expect(rt.lastVisibleTextPreview).toBe('partial')
    expect(rt.lastToolPreview).toBe('web_search')
    markSessionSending(sk, false)
    expect(rt.lastVisibleTextPreview).toBe('')
    expect(rt.lastToolPreview).toBe('')
  })

  it('isSessionRuntimeStreamVisible reads per-session stream not global ref', () => {
    const running = 'agent:main:test-stream-visible-running'
    const fresh = 'agent:main:test-stream-visible-fresh'
    const rtRun = getSessionRuntime(running)
    rtRun.stream.turn.openText = 'still streaming'
    expect(isSessionRuntimeStreamVisible(running)).toBe(true)
    expect(isSessionRuntimeStreamVisible(fresh)).toBe(false)
  })

  it('mountSessionRuntime does not inherit executingAlso as isSending without runtime live', () => {
    const sk = 'agent:main:test-mount-idle'
    const rt = getSessionRuntime(sk)
    rt.isSending = false
    rt.attachState = 'idle'
    const streamRef = { current: emptyStream() }
    const isSendingRef = { current: true }
    mountSessionRuntime(sk, {
      streamRef,
      setIsSending: (v) => {
        isSendingRef.current = v
      },
      isSendingRef,
      seenRunIdsRef: { current: new Set() },
      activeChatRunIdRef: { current: null },
    })
    expect(isSendingRef.current).toBe(false)
    expect(streamRef.current).toBe(rt.stream)
  })

  it('commit keeps runtime isSending when snapshot ref is stale', () => {
    const sk = 'agent:main:test-commit-sending'
    const rt = getSessionRuntime(sk)
    rt.isSending = true
    commitActiveSessionRuntime(sk, {
      rows: [],
      stream: emptyStream(),
      isSending: false,
      seenRunIds: [],
      activeChatRunId: null,
    })
    expect(getSessionRuntime(sk).isSending).toBe(true)
    rt.isSending = false
    commitActiveSessionRuntime(sk, {
      rows: [],
      stream: emptyStream(),
      isSending: false,
      seenRunIds: [],
      activeChatRunId: null,
    })
    expect(getSessionRuntime(sk).isSending).toBe(false)
  })

  it('mountSessionRuntime restores sending without legacy turnStartTs refs', () => {
    const skA = 'agent:main:test-timing-a'
    const skB = 'agent:main:test-timing-b'
    const streamRef = { current: emptyStream() }

    commitActiveSessionRuntime(skA, {
      rows: [{ role: 'user', text: 'go', timestamp: 1 }],
      stream: streamRef.current,
      isSending: true,
      seenRunIds: [],
      activeChatRunId: null,
    })

    mountSessionRuntime(skB, {
      streamRef: { current: emptyStream() },
      setIsSending: () => {},
      isSendingRef: { current: false },
      seenRunIdsRef: { current: new Set() },
      activeChatRunIdRef: { current: null },
    })

    mountSessionRuntime(skA, {
      streamRef,
      setIsSending: () => {},
      isSendingRef: { current: true },
      seenRunIdsRef: { current: new Set() },
      activeChatRunIdRef: { current: null },
    })
    expect(getSessionRuntime(skA).isSending).toBe(true)
  })
})

describe('deriveSessionRecoveryPhase', () => {
  it('does not treat stale running runStatus after local clear as unattached', () => {
    expect(
      deriveSessionRecoveryPhase({
        runStatus: 'running',
        attachState: 'idle',
        isSending: false,
      }),
    ).toBe('idle')
  })

  it('returns running_unattached when db running and attach is detached without snapshot', () => {
    expect(
      deriveSessionRecoveryPhase({
        runStatus: 'running',
        attachState: 'detached',
        isSending: false,
        snapshotAvailable: false,
      }),
    ).toBe('running_unattached')
  })

  it('returns live_attached when streaming', () => {
    expect(
      deriveSessionRecoveryPhase({
        runStatus: 'running',
        attachState: 'idle',
        isSending: true,
      }),
    ).toBe('live_attached')
  })
})

describe('recoveryPhaseLabel', () => {
  it('returns user-facing copy for recovery phases', () => {
    expect(recoveryPhaseLabel('running_unattached')).toContain('恢复')
    expect(recoveryPhaseLabel('attaching')).toContain('恢复')
    expect(recoveryPhaseLabel('idle')).toBeNull()
    expect(recoveryPhaseLabel('completed')).toBeNull()
  })

  it('does not treat in-flight send as completed recovery', () => {
    expect(
      deriveSessionRecoveryPhase({
        runStatus: 'idle',
        attachState: 'detached',
        isSending: true,
      }),
    ).toBe('idle')
    expect(
      recoveryPhaseLabel(
        deriveSessionRecoveryPhase({
          runStatus: 'idle',
          attachState: 'detached',
          isSending: true,
        }),
      ),
    ).toBeNull()
  })
})
