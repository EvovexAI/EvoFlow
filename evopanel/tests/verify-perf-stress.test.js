import { describe, expect, it } from 'vitest'
import { checkStreamSimBudgets } from '../src/react/lib/client-perf.ts'
import { compareStreamPaths, simulateTextOnlyStream } from '../src/react/lib/client-perf-scenarios.ts'
import {
  generateMultiToolRoundEvents,
  generateTextDeltaEvents,
  replayStreamEvents,
} from '../src/react/lib/stream-perf-replay.ts'

describe('verify-perf-stress (offline)', () => {
  it('5000 text deltas: live path keeps displayTick at zero', () => {
    const live = simulateTextOnlyStream(5000, { livePath: true })
    expect(live.displayTicks).toBe(0)
    expect(live.displayTickPerDelta).toBe(0)
    expect(checkStreamSimBudgets(live).ok).toBe(true)
  })

  it('10000 text deltas: live vs legacy reduction stays >95%', () => {
    const live = simulateTextOnlyStream(10_000, { livePath: true })
    const legacy = simulateTextOnlyStream(10_000, { livePath: false })
    expect(live.displayTicks).toBe(0)
    expect(legacy.displayTicks).toBe(10_000)
    const reduction = ((legacy.displayTicks - live.displayTicks) / legacy.displayTicks) * 100
    expect(reduction).toBeGreaterThan(95)
  })

  it('1000 tool rounds replay: ticks only on structural boundaries', () => {
    const events = generateMultiToolRoundEvents(1000)
    const live = replayStreamEvents(events, { livePath: true })
    expect(live.textDeltaCount).toBeGreaterThan(1000)
    expect(live.structuralCount).toBeGreaterThan(5000)
    expect(live.displayTicks).toBeLessThanOrEqual(live.structuralCount + 2)
    expect(live.displayTicks).toBeLessThan(live.eventCount * 0.6)
  })

  it('2000 tool rounds composite stream', () => {
    const live = replayStreamEvents(generateMultiToolRoundEvents(2000, { textCharsPerRound: 24 }), {
      livePath: true,
    })
    expect(live.structuralCount).toBeGreaterThan(10_000)
    expect(live.displayTicks).toBeLessThanOrEqual(live.structuralCount + 2)
  })

  it('compareStreamPaths at 2000 deltas', () => {
    const cmp = compareStreamPaths(2000)
    expect(cmp.live.displayTicks).toBe(0)
    expect(cmp.displayTickReductionPct).toBeGreaterThan(95)
  })
})
