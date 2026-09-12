import { describe, expect, it } from 'vitest'
import {
  collectExecutingSessionKeys,
  isBackendRunActive,
  isSessionExecuting,
  isSessionGoalActive,
  isSessionSidebarExecuting,
  isSessionTurnPhaseBusy,
  isSessionWireActive,
  markSessionGoalRunning,
  patchSessionListRunEnded,
  resolveTerminalRunStatus,
  setSessionExecutionProbe,
  finalizeSessionTurnEnded,
  abortSessionTurnEnded,
} from '../src/react/lib/session-execution/index.ts'
import {
  getSessionRuntime,
  markSessionSending,
  rtAddStoppedRun,
} from '../src/react/lib/session-runtime-store.ts'

describe('session-execution', () => {
  it('isBackendRunActive recognizes running and pending', () => {
    expect(isBackendRunActive('running')).toBe(true)
    expect(isBackendRunActive('pending')).toBe(true)
    expect(isBackendRunActive('idle')).toBe(false)
  })

  it('isSessionExecuting ignores stale backend run after user stop', () => {
    const sk = 'agent:main:test-exec-stop'
    const rt = getSessionRuntime(sk)
    rtAddStoppedRun(rt, 'run-stopped')
    expect(
      isSessionExecuting(sk, {
        sessionRow: { runStatus: 'running', currentRunId: 'run-stopped' },
      }),
    ).toBe(false)
    expect(
      isSessionSidebarExecuting(sk, {
        sessionRow: { runStatus: 'running', currentRunId: 'run-other' },
      }),
    ).toBe(true)
  })

  it('isSessionExecuting matches outbound sending phase', () => {
    const sk = 'agent:main:test-exec-sending'
    markSessionSending(sk, true)
    expect(isSessionExecuting(sk)).toBe(true)
    expect(isSessionTurnPhaseBusy(sk)).toBe(true)
    expect(isSessionWireActive(sk)).toBe(true)
  })

  it('collectExecutingSessionKeys scans session list rows', () => {
    const keys = collectExecutingSessionKeys([
      { sessionKey: 'a', runStatus: 'idle' },
      { sessionKey: 'b', runStatus: 'running', currentRunId: 'r1' },
    ])
    expect(keys.has('a')).toBe(false)
    expect(keys.has('b')).toBe(true)
  })

  it('patchSessionListRunEnded updates matching session only', () => {
    const ended = '2026-06-30T00:00:00.000Z'
    const next = patchSessionListRunEnded(
      [
        { sessionKey: 'a', runStatus: 'running', currentRunId: 'r1' },
        { sessionKey: 'b', runStatus: 'running', currentRunId: 'r2' },
      ],
      'a',
      ended,
    )
    expect(next[0]).toMatchObject({
      runStatus: 'done',
      currentRunId: null,
      currentTurnEndedAt: ended,
    })
    expect(next[1].runStatus).toBe('running')
  })

  it('resolveTerminalRunStatus maps stop and error reasons', () => {
    expect(resolveTerminalRunStatus({ terminalStatus: 'cancelled' })).toBe('cancelled')
    expect(resolveTerminalRunStatus({ reason: 'user_stop' })).toBe('cancelled')
    expect(resolveTerminalRunStatus({ aborted: true })).toBe('cancelled')
    expect(resolveTerminalRunStatus({ failed: true })).toBe('fail')
    expect(resolveTerminalRunStatus({ reason: 'completed' })).toBe('done')
  })

  it('finalizeSessionTurnEnded clears turn phase and records stopped run', () => {
    const sk = 'agent:main:test-finalize'
    const rt = getSessionRuntime(sk)
    rt.activeChatRunId = 'run-final'
    markSessionSending(sk, true)
    finalizeSessionTurnEnded(sk, { stopRunId: 'run-final' })
    expect(isSessionTurnPhaseBusy(sk)).toBe(false)
    expect(rt.stoppedRunIds.includes('run-final')).toBe(true)
  })

  it('isSessionGoalActive reflects goal-mode-state module', () => {
    const sk = 'agent:main:test-hosted'
    markSessionGoalRunning(sk, true)
    expect(isSessionGoalActive(sk)).toBe(true)
    markSessionGoalRunning(sk, false)
    expect(isSessionGoalActive(sk)).toBe(false)
  })

  it('isSessionExecuting uses backend probe executing flag', () => {
    const sk = 'agent:main:test-probe-exec'
    setSessionExecutionProbe(sk, { executing: true, goalActive: false, runStatus: 'running' })
    expect(isSessionExecuting(sk, { sessionRow: { runStatus: 'idle', currentRunId: 'run-bg' } })).toBe(true)
  })

  it('isSessionExecuting ignores probe and DB during recovery cooldown after user stop', async () => {
    const { markSessionRecoveryCooldown } = await import('../src/react/lib/stream-reattach-cooldown.js')
    const sk = 'agent:main:test-recovery-cooldown'
    markSessionRecoveryCooldown(sk)
    setSessionExecutionProbe(sk, { executing: true, goalActive: false, runStatus: 'running' })
    expect(
      isSessionExecuting(sk, {
        sessionRow: { runStatus: 'running', currentRunId: 'run-stale' },
      }),
    ).toBe(false)
  })

  it('abortSessionTurnEnded sets turn phase idle', () => {
    const sk = 'agent:main:test-abort-end'
    markSessionSending(sk, true)
    abortSessionTurnEnded(sk, { stopRunId: 'run-abort' })
    expect(isSessionTurnPhaseBusy(sk)).toBe(false)
  })
})
