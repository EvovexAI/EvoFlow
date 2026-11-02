import { describe, expect, it } from 'vitest'
import {
  sessionLooksRunning,
  shouldAutoStreamResume,
  shouldManualRefreshResumeStream,
  shouldSkipRefreshAttach,
  shouldStartObserverHistoryWatch,
  shouldSuppressAutoReattach,
} from '../src/react/lib/stream-resume-gate.ts'
import {
  clearSessionRuntime,
  dispatchSessionTurnEvent,
  getSessionRuntime,
  markSessionStreamWireSource,
} from '../src/react/lib/session-runtime-store.js'

describe('stream-resume-gate', () => {
  it('shouldAutoStreamResume requires key and not busy', () => {
    clearSessionRuntime('sk1')
    expect(
      shouldAutoStreamResume({
        selectedSessionKey: '',
      }),
    ).toBe(false)
    expect(
      shouldAutoStreamResume({
        selectedSessionKey: 'sk1',
        sessionRow: { sessionKey: 'sk1', runStatus: 'running' },
      }),
    ).toBe(true)
    expect(
      shouldAutoStreamResume({
        selectedSessionKey: 'sk1',
        executingSessionKeys: new Set(['sk1']),
      }),
    ).toBe(true)
  })

  it('shouldSkipRefreshAttach when attempted thread is idle', () => {
    expect(
      shouldSkipRefreshAttach({
        sessionKey: 'sk1',
        threadId: 't1',
        attemptedThreadId: 't1',
        looksRunning: false,
      }),
    ).toBe(true)
    expect(
      shouldSkipRefreshAttach({
        sessionKey: 'sk1',
        threadId: 't1',
        attemptedThreadId: 't1',
        looksRunning: true,
      }),
    ).toBe(false)
  })

  it('sessionLooksRunning uses runStatus and executing set', () => {
    expect(sessionLooksRunning({ sessionKey: 'sk1', runStatus: 'idle' })).toBe(false)
    expect(sessionLooksRunning({ sessionKey: 'sk1', runStatus: 'pending' })).toBe(true)
    expect(
      sessionLooksRunning({
        sessionKey: 'sk1',
        runStatus: 'idle',
        executingSessionKeys: new Set(['sk1']),
      }),
    ).toBe(true)
  })

  it('shouldManualRefreshResumeStream resumes only when run or stream is active', () => {
    clearSessionRuntime('sk1')
    expect(
      shouldManualRefreshResumeStream({
        sessionKey: 'sk1',
        runStatus: 'idle',
      }),
    ).toBe(false)
    expect(
      shouldManualRefreshResumeStream({
        sessionKey: 'sk1',
        runStatus: 'running',
      }),
    ).toBe(true)
    expect(
      shouldManualRefreshResumeStream({
        sessionKey: 'sk1',
        runStatus: 'idle',
        executingSessionKeys: new Set(['sk1']),
      }),
    ).toBe(true)
  })

  it('shouldManualRefreshResumeStream resumes when stream wire is active', () => {
    const sk = 'agent:main:wire-test'
    markSessionStreamWireSource(sk, 'stream-resume')
    expect(
      shouldManualRefreshResumeStream({
        sessionKey: sk,
        runStatus: 'idle',
      }),
    ).toBe(true)
    markSessionStreamWireSource(sk, 'run')
    expect(
      shouldManualRefreshResumeStream({
        sessionKey: sk,
        runStatus: 'idle',
      }),
    ).toBe(true)
    markSessionStreamWireSource(sk, null)
  })

  it('shouldSuppressAutoReattach blocks during POST stream wire', () => {
    const sk = 'agent:main:suppress-test'
    markSessionStreamWireSource(sk, 'run')
    expect(
      shouldSuppressAutoReattach({
        sessionKey: sk,
      }),
    ).toBe(true)
    markSessionStreamWireSource(sk, null)
    expect(
      shouldSuppressAutoReattach({
        sessionKey: sk,
      }),
    ).toBe(false)
  })

  it('observerCatchup allows history-watch when busy without live POST wire', () => {
    const sk = 'agent:main:observer-feishu'
    clearSessionRuntime(sk)
    dispatchSessionTurnEvent(sk, { type: 'SEND_STARTED' })
    dispatchSessionTurnEvent(sk, { type: 'RUN_LIVE', runId: 'run-feishu-1' })
    // Mirrored busy turn, but this client never opened POST /runs/stream
    expect(
      shouldSuppressAutoReattach({
        sessionKey: sk,
        observerCatchup: true,
      }),
    ).toBe(false)
    expect(
      shouldStartObserverHistoryWatch({
        sessionKey: sk,
        runStatus: 'running',
      }),
    ).toBe(true)
    markSessionStreamWireSource(sk, 'run')
    expect(
      shouldStartObserverHistoryWatch({
        sessionKey: sk,
        runStatus: 'running',
      }),
    ).toBe(false)
    expect(
      shouldSuppressAutoReattach({
        sessionKey: sk,
        observerCatchup: true,
      }),
    ).toBe(true)
    markSessionStreamWireSource(sk, null)
    clearSessionRuntime(sk)
  })

  it('shouldSuppressAutoReattach still blocks live POST even with manualForce', () => {
    const sk = 'agent:main:suppress-manual-force'
    markSessionStreamWireSource(sk, 'run')
    expect(
      shouldSuppressAutoReattach({
        sessionKey: sk,
        manualForce: true,
      }),
    ).toBe(true)
    markSessionStreamWireSource(sk, 'stream-resume')
    expect(
      shouldSuppressAutoReattach({
        sessionKey: sk,
        manualForce: true,
      }),
    ).toBe(false)
    markSessionStreamWireSource(sk, null)
  })

  it('blocks auto resume after early uiTurnSettled even when DB still running', () => {
    const sk = 'agent:main:settled-no-resume'
    clearSessionRuntime(sk)
    dispatchSessionTurnEvent(sk, { type: 'SEND_STARTED' })
    dispatchSessionTurnEvent(sk, { type: 'RUN_LIVE', runId: 'run-1' })
    dispatchSessionTurnEvent(sk, { type: 'TURN_IDLE' })
    expect(getSessionRuntime(sk).uiTurnSettled).toBe(true)

    expect(
      shouldSuppressAutoReattach({
        sessionKey: sk,
      }),
    ).toBe(true)
    expect(
      shouldManualRefreshResumeStream({
        sessionKey: sk,
        runStatus: 'running',
      }),
    ).toBe(false)
    expect(
      shouldAutoStreamResume({
        selectedSessionKey: sk,
        sessionRow: { sessionKey: sk, runStatus: 'running' },
      }),
    ).toBe(false)
    clearSessionRuntime(sk)
  })
})
