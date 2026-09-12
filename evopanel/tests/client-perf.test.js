import { describe, expect, it } from 'vitest'
import {
  CLIENT_PERF_BUDGETS,
  checkStreamSimBudgets,
  getClientPerfSnapshot,
  noteDisplayTickBump,
  noteLiveStreamPublish,
  noteSseTextDelta,
  percentile,
  resetClientPerfForTests,
  setChatSurfaceVisible,
} from '../src/react/lib/client-perf.ts'

describe('client-perf', () => {
  it('percentile handles empty and ordered samples', () => {
    expect(percentile([], 95)).toBeUndefined()
    expect(percentile([7], 95)).toBe(7)
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30)
    expect(percentile([10, 20, 30, 40, 50], 95)).toBe(50)
  })

  it('tracks counters and chat surface visibility', () => {
    resetClientPerfForTests()
    noteDisplayTickBump()
    noteLiveStreamPublish()
    noteSseTextDelta()
    noteSseTextDelta()
    setChatSurfaceVisible(false)
    const snap = getClientPerfSnapshot()
    expect(snap.displayTickBumps).toBe(1)
    expect(snap.liveStreamPublishes).toBe(1)
    expect(snap.sseTextDeltas).toBe(2)
    expect(snap.chatSurfaceVisible).toBe(false)
  })

  it('checkStreamSimBudgets passes live path with low tick ratio', () => {
    const ok = checkStreamSimBudgets({
      displayTickPerDelta: 0,
      livePublishes: 12,
      livePathEnabled: true,
    })
    expect(ok.ok).toBe(true)
    expect(ok.failures).toEqual([])
  })

  it('checkStreamSimBudgets fails when live path still bumps list', () => {
    const bad = checkStreamSimBudgets({
      displayTickPerDelta: 0.5,
      livePublishes: 10,
      livePathEnabled: true,
    })
    expect(bad.ok).toBe(false)
    expect(bad.failures[0]).toContain(String(CLIENT_PERF_BUDGETS.displayTickPerDeltaLiveMax))
  })
})
