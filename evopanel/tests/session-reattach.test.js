import { describe, expect, it, vi } from 'vitest'
import {
  isActiveRunStatus,
  isSessionRunStillActive,
  isTerminalRunStatus,
  maybeClearTurnSendingState,
  resolveRunIdsFromStatus,
  reattachRunningSessionIfNeeded,
} from '../src/react/lib/session-reattach.ts'
import { createEmptySessionRuntime, getSessionRuntime } from '../src/react/lib/session-runtime-store.ts'

describe('session-reattach', () => {
  it('isActiveRunStatus detects running/pending', () => {
    expect(isActiveRunStatus('running')).toBe(true)
    expect(isActiveRunStatus('pending')).toBe(true)
    expect(isActiveRunStatus('idle')).toBe(false)
  })

  it('isTerminalRunStatus detects done/cancelled', () => {
    expect(isTerminalRunStatus('done')).toBe(true)
    expect(isTerminalRunStatus('cancelled')).toBe(true)
    expect(isTerminalRunStatus('running')).toBe(false)
    expect(isTerminalRunStatus('')).toBe(false)
  })

  it('resolveRunIdsFromStatus reads nested run fields', () => {
    expect(resolveRunIdsFromStatus({ runId: 'r1', status: 'running' })).toEqual({
      runId: 'r1',
      status: 'running',
    })
    expect(
      resolveRunIdsFromStatus({ run: { run_id: 'r2', status: 'pending' }, status: 'idle' }),
    ).toEqual({ runId: 'r2', status: 'idle' })
  })

  it('isSessionRunStillActive returns false when execution state is done', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          ok: true,
          runStatus: 'done',
          attachRecommended: false,
          langgraphActive: false,
        }),
      })),
    )
    await expect(isSessionRunStillActive('sk-done')).resolves.toBe(false)
    vi.unstubAllGlobals()
  })

  it('reattach returns idle when execution state says no attach', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          ok: true,
          runStatus: 'done',
          attachRecommended: false,
          streamResumeRecommended: false,
          langgraphActive: false,
        }),
      })),
    )
    const result = await reattachRunningSessionIfNeeded({
      sessionKey: 'sk-after-final',
      wsClient: {
        getSessionThreadId: () => 'thread-1',
      },
      sessionRow: { threadId: 'thread-1', currentRunId: 'run-lag', runStatus: 'running' },
    })
    expect(result).toBe('idle')
    vi.unstubAllGlobals()
  })

  it('isSessionRunStillActive trusts runtime-status attachRecommended', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          ok: true,
          runStatus: 'running',
          attachRecommended: true,
          langgraphActive: true,
        }),
      })),
    )
    await expect(isSessionRunStillActive('sk-active')).resolves.toBe(true)
    vi.unstubAllGlobals()
  })

  it('maybeClearTurnSendingState resumes when run still active', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          ok: true,
          runStatus: 'running',
          attachRecommended: true,
        }),
      })),
    )
    const onClear = vi.fn()
    const onResume = vi.fn()
    const result = await maybeClearTurnSendingState({
      sessionKey: 'sk3',
      wsClient: {},
      onClear,
      onResume,
    })
    expect(result).toBe('resumed')
    expect(onResume).toHaveBeenCalled()
    expect(onClear).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('reattach returns idle when no active run', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          ok: true,
          runStatus: 'idle',
          attachRecommended: false,
        }),
      })),
    )
    const wsClient = {
      getSessionThreadId: () => 'thread-1',
    }
    const result = await reattachRunningSessionIfNeeded({
      sessionKey: 'sk1',
      wsClient,
      sessionRow: { threadId: 'thread-1', runStatus: 'idle' },
    })
    expect(result).toBe('idle')
    vi.unstubAllGlobals()
  })

  it('reattach history-watches without calling stream-resume', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1
        return {
          ok: true,
          json: async () => ({
            ok: true,
            runStatus: calls >= 2 ? 'done' : 'running',
            runId: 'run-1',
            threadId: 'thread-1',
            attachRecommended: calls < 2,
          }),
        }
      }),
    )
    const resume = vi.fn(async () => ({ ok: true }))
    const reloadHistory = vi.fn(async () => ({}))
    const wsClient = {
      getSessionThreadId: () => 'thread-1',
      resumeChatStream: resume,
    }
    const result = await reattachRunningSessionIfNeeded({
      sessionKey: 'sk2',
      wsClient,
      sessionRow: { threadId: 'thread-1', currentRunId: 'run-1', runStatus: 'running' },
      reloadHistory,
      historyPollIntervalMs: 10,
      historyPollMaxAttempts: 3,
    })
    expect(result).toBe('idle')
    expect(resume).not.toHaveBeenCalled()
    expect(reloadHistory.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(getSessionRuntime('sk2').activeChatRunId).toBe('run-1')
    vi.unstubAllGlobals()
  })

  it('reattach returns degraded when still running after max polls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          ok: true,
          runStatus: 'running',
          runId: 'run-busy',
          threadId: 'thread-1',
          attachRecommended: true,
        }),
      })),
    )
    const resume = vi.fn(async () => ({ ok: true }))
    const result = await reattachRunningSessionIfNeeded({
      sessionKey: 'sk-busy',
      wsClient: {
        getSessionThreadId: () => 'thread-1',
        resumeChatStream: resume,
      },
      sessionRow: { threadId: 'thread-1', currentRunId: 'run-busy', runStatus: 'running' },
      historyPollIntervalMs: 5,
      historyPollMaxAttempts: 1,
    })
    expect(result).toBe('degraded')
    expect(resume).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('session recovery phase', () => {
  it('deriveSessionRecoveryPhase from store helpers', async () => {
    const { deriveSessionRecoveryPhase, recoveryPhaseLabel } = await import(
      '../src/react/lib/session-runtime-store.ts'
    )
    expect(deriveSessionRecoveryPhase({ runStatus: 'running', turnPhase: 'reattaching' })).toBe('attaching')
    expect(recoveryPhaseLabel('attaching')).toContain('恢复')
    const rt = createEmptySessionRuntime()
    expect(rt.attachState === 'idle' || rt.attachState == null).toBe(true)
  })
})
