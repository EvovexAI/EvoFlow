import { describe, expect, it } from 'vitest'
import { checkStreamSimBudgets } from '../src/react/lib/client-perf.ts'
import {
  compareStreamPaths,
  simulateDualSessionStreamSwitch,
  simulateTextOnlyStream,
} from '../src/react/lib/client-perf-scenarios.ts'
import { setLiveStreamPathEnabled } from '../src/react/lib/stream-live-path-toggle.ts'

describe('client-perf-scenarios', () => {
  it('live path avoids display tick storms on text-only deltas', () => {
    const live = simulateTextOnlyStream(500, { livePath: true })
    expect(live.displayTicks).toBe(0)
    expect(live.liveEpoch).toBeGreaterThan(0)
    expect(live.displayTickPerDelta).toBeLessThanOrEqual(0.05)
    expect(checkStreamSimBudgets(live).ok).toBe(true)
  })

  it('legacy path bumps display tick per text delta', () => {
    const legacy = simulateTextOnlyStream(500, { livePath: false })
    expect(legacy.displayTicks).toBe(500)
    expect(legacy.displayTickPerDelta).toBeGreaterThanOrEqual(0.5)
    expect(checkStreamSimBudgets(legacy).ok).toBe(true)
  })

  it('compareStreamPaths reports large reduction', () => {
    setLiveStreamPathEnabled(true)
    const cmp = compareStreamPaths(500)
    expect(cmp.live.displayTicks).toBeLessThan(cmp.legacy.displayTicks * 0.1)
    expect(cmp.displayTickReductionPct).toBeGreaterThan(90)
    expect(cmp.liveMeetsBudget).toBe(true)
  })

  it('hibernated chat surface avoids display tick bumps and live publishes', () => {
    const hidden = simulateTextOnlyStream(300, { livePath: true, chatVisible: false })
    expect(hidden.displayTicks).toBe(0)
    expect(hidden.liveEpoch).toBe(0)
    expect(hidden.chatSurfaceVisible).toBe(false)
  })

  it('dual-session switch keeps display ticks at zero and only notifies subscribed session', () => {
    const dual = simulateDualSessionStreamSwitch({ deltasPerBurst: 80, switchCount: 3 })
    expect(dual.displayTicks).toBe(0)
    expect(dual.activeEpochA).toBeGreaterThan(0)
    expect(dual.activeEpochB).toBeGreaterThan(0)
    const totalStoreUpdates = dual.deltasPerBurst * dual.switchCount * 2
    expect(dual.livePublishes).toBe(totalStoreUpdates)
    const notifiedMax = dual.deltasPerBurst * dual.switchCount
    expect(dual.subscriberNotifies).toBeLessThanOrEqual(notifiedMax)
    expect(dual.subscriberNotifies).toBeGreaterThan(0)
    expect(dual.subscriberNotifies).toBeLessThan(dual.livePublishes)
  })
})
