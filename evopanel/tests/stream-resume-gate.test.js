import { describe, expect, it } from 'vitest'
import {
  sessionLooksRunning,
  shouldAutoStreamResume,
  shouldManualRefreshResumeStream,
  shouldSkipRefreshAttach,
  shouldSuppressAutoReattach,
} from '../src/react/lib/stream-resume-gate.ts'
import {
  getSessionRuntime,
  markSessionStreamWireSource,
} from '../src/react/lib/session-runtime-store.js'

describe('stream-resume-gate', () => {
  it('shouldAutoStreamResume requires key and not sending', () => {
    expect(
      shouldAutoStreamResume({
        selectedSessionKey: '',
        isSending: false,
      }),
    ).toBe(false)
    expect(
      shouldAutoStreamResume({
        selectedSessionKey: 'sk1',
        isSending: true,
        sessionRow: { sessionKey: 'sk1', runStatus: 'running' },
      }),
    ).toBe(false)
    expect(
      shouldAutoStreamResume({
        selectedSessionKey: 'sk1',
        isSending: false,
        sessionRow: { sessionKey: 'sk1', runStatus: 'running' },
      }),
    ).toBe(true)
    expect(
      shouldAutoStreamResume({
        selectedSessionKey: 'sk1',
        isSending: false,
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
        isForegroundSending: true,
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
})
