/**
 * 手动回归（runId 轮次隔离）：
 * 1. 连续两轮带工具+思考 → final 后无上一轮工具/正文闪现
 * 2. 第一轮停止 → 再发 → 第二次停止仍有效，partial 不落空
 * 3. 刷新后 attach 续挂：仍属同一 runId，无新开轮
 */
import { describe, expect, it } from 'vitest'
import {
  bindActiveRun,
  clearActiveRun,
  markRunSealing,
  shouldApplyChatEvent,
} from '../src/react/lib/run-turn-gate.ts'
import { createEmptySessionRuntime } from '../src/react/lib/session-runtime-store.ts'

describe('run-turn-gate', () => {
  it('rejects events without runId', () => {
    const rt = createEmptySessionRuntime()
    expect(shouldApplyChatEvent(rt, { state: 'delta' })).toBe(false)
  })

  it('allows run_started before active bind', () => {
    const rt = createEmptySessionRuntime()
    expect(shouldApplyChatEvent(rt, { runId: 'r1', state: 'run_started' })).toBe(true)
    expect(shouldApplyChatEvent(rt, { runId: 'r1', state: 'delta' })).toBe(false)
  })

  it('bindActiveRun then accepts matching run only', () => {
    const rt = createEmptySessionRuntime()
    bindActiveRun(rt, 'r1')
    expect(shouldApplyChatEvent(rt, { runId: 'r1', state: 'delta' })).toBe(true)
    expect(shouldApplyChatEvent(rt, { runId: 'r2', state: 'delta' })).toBe(false)
  })

  it('sealing allows final/aborted for active run', () => {
    const rt = createEmptySessionRuntime()
    bindActiveRun(rt, 'r1')
    markRunSealing(rt)
    expect(shouldApplyChatEvent(rt, { runId: 'r1', state: 'delta' })).toBe(false)
    expect(shouldApplyChatEvent(rt, { runId: 'r1', state: 'final' })).toBe(true)
    expect(shouldApplyChatEvent(rt, { runId: 'r1', state: 'aborted' })).toBe(true)
  })

  it('clearActiveRun resets live status', () => {
    const rt = createEmptySessionRuntime()
    bindActiveRun(rt, 'r1')
    clearActiveRun(rt)
    expect(rt.activeChatRunId).toBe(null)
    expect(rt.liveRunStatus).toBe(null)
  })

  it('knownRunId allows delta before explicit bind (reattach recovery)', () => {
    const rt = createEmptySessionRuntime()
    expect(
      shouldApplyChatEvent(rt, { runId: 'r1', state: 'delta' }, { knownRunId: 'r1' }),
    ).toBe(true)
    expect(
      shouldApplyChatEvent(rt, { runId: 'r2', state: 'delta' }, { knownRunId: 'r1' }),
    ).toBe(false)
  })

  it('fresh send rejects stale knownRunId until expected run is bound', () => {
    const rt = createEmptySessionRuntime()
    rt.turnPhase = 'outbound'
    expect(
      shouldApplyChatEvent(rt, { runId: 'old-run', state: 'delta' }, { knownRunId: 'old-run' }),
    ).toBe(false)
    expect(
      shouldApplyChatEvent(
        rt,
        { runId: 'new-run', state: 'delta' },
        { knownRunId: 'old-run', expectedRunId: 'new-run' },
      ),
    ).toBe(true)
    expect(
      shouldApplyChatEvent(
        rt,
        { runId: 'old-run', state: 'delta' },
        { knownRunId: 'old-run', expectedRunId: 'new-run' },
      ),
    ).toBe(false)
  })

  it('reattach while attaching still accepts knownRunId', () => {
    const rt = createEmptySessionRuntime()
    rt.isSending = true
    rt.attachState = 'attaching'
    expect(
      shouldApplyChatEvent(rt, { runId: 'r1', state: 'delta' }, { knownRunId: 'r1' }),
    ).toBe(true)
  })

  it('knownRunId does not bypass sealing for non-terminal events', () => {
    const rt = createEmptySessionRuntime()
    bindActiveRun(rt, 'r1')
    markRunSealing(rt)
    expect(
      shouldApplyChatEvent(rt, { runId: 'r1', state: 'delta' }, { knownRunId: 'r1' }),
    ).toBe(false)
  })

  it('agui_event with wire run id accepted when active is client provisional uuid', () => {
    const rt = createEmptySessionRuntime()
    bindActiveRun(rt, '962fdcd0-ff9c-448c-9476-43eb06da203a')
    expect(
      shouldApplyChatEvent(rt, {
        runId: 'run-5748be2984b1',
        state: 'agui_event',
      }),
    ).toBe(true)
    expect(
      shouldApplyChatEvent(rt, {
        runId: 'other-client-uuid',
        state: 'agui_event',
      }),
    ).toBe(false)
  })

  it('final with client run id accepted when active is wire run (same turn)', () => {
    const rt = createEmptySessionRuntime()
    bindActiveRun(rt, 'run-918f09158519')
    expect(
      shouldApplyChatEvent(
        rt,
        { runId: 'cb452e7f-f2f8-4753-91ce-2954a63b785b', state: 'final' },
        { allowSealingTerminal: true },
      ),
    ).toBe(true)
  })
})
