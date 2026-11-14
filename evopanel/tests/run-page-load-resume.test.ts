import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runPageLoadResumeEffect } from '../src/react/chat-app/shell/run-page-load-resume.ts'

// mock V4 面（run-page-load-resume 静态 import）：v4Gate 开关 + 共享 data layer 快照
const mocks = vi.hoisted(() => ({
  v4Enabled: true,
  snapshot: null as Record<string, unknown> | null,
  hasStore: true,
}))

vi.mock('../src/react/v4/v4Gate.js', () => ({
  isEvoflowChatV4Enabled: () => mocks.v4Enabled,
}))

vi.mock('../src/react/v4/V4StreamRowsBridge.js', () => ({
  getSharedV4SessionDataLayer: () => ({
    peekStore: (_tid: string) =>
      mocks.hasStore ? { getState: () => ({ snapshot: mocks.snapshot }) } : null,
  }),
}))

const SK = 'agent:main:new-f6c85737'
const TID = 'lead-0000__main'

function baseCtx(overrides: Record<string, unknown> = {}) {
  return {
    listLoading: false,
    pageLoadResumeDoneRef: { current: false },
    requestManualStreamResumeRef: { current: vi.fn() },
    selectedSessionKey: SK,
    sessions: [
      { sessionKey: SK, threadId: TID, runStatus: 'running', currentRunId: 'run-old', updatedAt: Date.now() },
    ],
    stopSessionExecutionRef: { current: vi.fn() },
    toast: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  mocks.v4Enabled = true
  mocks.snapshot = null
  mocks.hasStore = true
})

afterEach(() => {
  vi.useRealTimers()
})

describe('runPageLoadResumeEffect', () => {
  it('stops interrupted running session on page load instead of auto-resuming', () => {
    // 无 threadId（旧会话缺绑定）→ 走旧规则立即 stop
    const ctx = baseCtx({
      sessions: [{ sessionKey: SK, runStatus: 'running', currentRunId: 'run-old', updatedAt: Date.now() }],
    })
    runPageLoadResumeEffect(ctx)
    expect(ctx.pageLoadResumeDoneRef.current).toBe(true)
    expect(ctx.stopSessionExecutionRef.current).toHaveBeenCalledWith(SK, {
      showToast: false,
      source: 'page_load_interrupt_stop',
    })
    expect(ctx.requestManualStreamResumeRef.current).not.toHaveBeenCalled()
  })

  it('no-ops when selected session is idle', () => {
    const ctx = baseCtx({
      sessions: [{ sessionKey: SK, threadId: TID, runStatus: 'idle' }],
    })
    runPageLoadResumeEffect(ctx)
    expect(ctx.pageLoadResumeDoneRef.current).toBe(true)
    expect(ctx.stopSessionExecutionRef.current).not.toHaveBeenCalled()
  })

  it('skips auto-stop when projection restored running (Phase B hydrate)', async () => {
    mocks.snapshot = { control: { canStop: true, phase: 'running' } }
    const ctx = baseCtx()
    runPageLoadResumeEffect(ctx)
    await new Promise((r) => setTimeout(r, 60))
    expect(ctx.stopSessionExecutionRef.current).not.toHaveBeenCalled()
  })

  it('stops when projection reports not-running (stale DB row)', async () => {
    mocks.snapshot = { control: { canStop: false, phase: 'draft' } }
    const ctx = baseCtx()
    runPageLoadResumeEffect(ctx)
    await new Promise((r) => setTimeout(r, 60))
    expect(ctx.stopSessionExecutionRef.current).toHaveBeenCalledWith(SK, {
      showToast: false,
      source: 'page_load_interrupt_stop',
    })
  })

  it('stops immediately when V4 disabled', async () => {
    mocks.v4Enabled = false
    mocks.snapshot = { control: { canStop: true, phase: 'running' } }
    const ctx = baseCtx()
    runPageLoadResumeEffect(ctx)
    await new Promise((r) => setTimeout(r, 60))
    expect(ctx.stopSessionExecutionRef.current).toHaveBeenCalledWith(SK, {
      showToast: false,
      source: 'page_load_interrupt_stop',
    })
  })

  it('stops after grace timeout when no projection verdict arrives', async () => {
    vi.useFakeTimers()
    mocks.hasStore = false // peekStore null：整个宽限期无裁决
    const ctx = baseCtx()
    runPageLoadResumeEffect(ctx)
    await vi.advanceTimersByTimeAsync(3400)
    expect(ctx.stopSessionExecutionRef.current).toHaveBeenCalledWith(SK, {
      showToast: false,
      source: 'page_load_interrupt_stop',
    })
  })

  it('skips stop only while control says running; terminal verdict stops', async () => {
    mocks.snapshot = { control: { canStop: false, phase: 'completedInterrupted' } }
    const ctx = baseCtx()
    runPageLoadResumeEffect(ctx)
    await new Promise((r) => setTimeout(r, 60))
    expect(ctx.stopSessionExecutionRef.current).toHaveBeenCalled()
  })
})
