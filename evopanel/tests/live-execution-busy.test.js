import { describe, expect, it } from 'vitest'
import {
  hasLiveToolCallRows,
  hasStreamingContentRows,
  resolveLiveExecutionBusy,
  resolveLiveExecutionBusyFromSnapshot,
} from '../src/zcode-ui/v4/live-execution-busy.ts'

describe('live-execution-busy', () => {
  it('keeps busy when toolCall still running after canStop=false', () => {
    expect(
      resolveLiveExecutionBusy({
        canStop: false,
        phase: 'completedSuccess',
        rows: [{ kind: 'toolCall', status: 'running' }],
      }),
    ).toBe(true)
  })

  it('idles stale running tools when host already idle on terminal phase', () => {
    expect(
      resolveLiveExecutionBusy({
        canStop: false,
        phase: 'completedSuccess',
        hostExecuting: false,
        rows: [{ kind: 'toolCall', status: 'running' }],
      }),
    ).toBe(false)
  })

  it('ignores lagged canStop when host already idle', () => {
    expect(
      resolveLiveExecutionBusy({
        canStop: true,
        phase: 'running',
        hostExecuting: false,
        rows: [{ kind: 'toolCall', status: 'success' }],
      }),
    ).toBe(true) // phase still running → keep busy (sse_final early)
    expect(
      resolveLiveExecutionBusy({
        canStop: true,
        phase: 'completedSuccess',
        hostExecuting: false,
        rows: [{ kind: 'toolCall', status: 'success' }],
      }),
    ).toBe(false) // terminal + host idle：不信滞后 canStop
  })

  it('keeps pendingApproval busy even when host idle on terminal phase', () => {
    expect(
      resolveLiveExecutionBusy({
        canStop: false,
        phase: 'completedSuccess',
        hostExecuting: false,
        rows: [{ kind: 'toolCall', status: 'pendingApproval' }],
      }),
    ).toBe(true)
  })

  it('treats empty-status toolCall in tail as live mid-run; ignores on terminal', () => {
    expect(
      resolveLiveExecutionBusy({
        canStop: false,
        phase: 'running',
        rows: [{ kind: 'toolCall', status: '' }],
      }),
    ).toBe(true)
    expect(
      resolveLiveExecutionBusy({
        canStop: false,
        phase: 'completedSuccess',
        rows: [{ kind: 'toolCall', status: '' }],
      }),
    ).toBe(false)
    const buried = Array.from({ length: 20 }, () => ({
      kind: 'assistantText',
      state: 'complete',
    }))
    // 空 status 埋在窗头、末 6 全是 success：终态下不 busy
    expect(
      resolveLiveExecutionBusy({
        canStop: false,
        phase: 'completedSuccess',
        rows: [
          { kind: 'toolCall', status: '' },
          ...Array.from({ length: 20 }, () => ({ kind: 'toolCall', status: 'success' })),
        ],
      }),
    ).toBe(false)
  })

  it('keeps busy while assistantText is streaming', () => {
    expect(hasStreamingContentRows([{ kind: 'assistantText', state: 'streaming' }])).toBe(true)
    expect(
      resolveLiveExecutionBusy({
        canStop: false,
        phase: 'completedSuccess',
        rows: [{ kind: 'assistantText', state: 'streaming' }],
      }),
    ).toBe(true)
  })

  it('keeps busy for background bash count', () => {
    expect(
      resolveLiveExecutionBusy({
        canStop: false,
        phase: 'completedSuccess',
        rows: [],
        runningBackgroundWorkCount: 1,
      }),
    ).toBe(true)
  })

  it('idles when nothing live', () => {
    expect(
      resolveLiveExecutionBusy({
        canStop: false,
        phase: 'completedSuccess',
        rows: [
          { kind: 'toolCall', status: 'success' },
          { kind: 'assistantText', state: 'complete' },
        ],
        runningBackgroundWorkCount: 0,
      }),
    ).toBe(false)
  })

  it('reads snapshot window rows', () => {
    expect(hasLiveToolCallRows([{ kind: 'toolCall', status: 'inputStreaming' }])).toBe(true)
    expect(
      resolveLiveExecutionBusyFromSnapshot({
        control: { canStop: false, phase: 'completedSuccess' },
        rows: { window: [{ kind: 'toolCall', status: 'running' }] },
      }),
    ).toBe(true)
    expect(
      resolveLiveExecutionBusyFromSnapshot(
        {
          control: { canStop: false, phase: 'completedSuccess' },
          rows: { window: [{ kind: 'toolCall', status: 'running' }] },
        },
        undefined,
        { hostExecuting: false },
      ),
    ).toBe(false)
  })
})
