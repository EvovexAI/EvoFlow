/**
 * Regression: React 19.2 dev build writes one performance.measure entry per component
 * render (component tracks, "​"-prefixed names) and Chrome's User Timing buffer is
 * unbounded — streaming sessions accumulate millions of entries (~GB/h) and the renderer
 * OOM-crashes. The dev-only guard must clear the buffer once it exceeds a threshold,
 * and should drop React ZWSP measures at the source so clears stay cheap.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { installReactMeasureFilter, startUserTimingGuard } from '../src/lib/user-timing-guard.js'

function fakePerf(initial) {
  return {
    count: initial,
    cleared: 0,
    getEntriesByType(type) {
      return type === 'measure' ? { length: this.count } : []
    },
    clearMeasures() {
      this.cleared++
      this.count = 0
    },
  }
}

describe('installReactMeasureFilter', () => {
  it('drops React ZWSP-prefixed measure names and counts others', () => {
    const calls = []
    const perf = {
      measure(name, ...rest) {
        calls.push([name, ...rest])
      },
      clearMeasures() {},
    }
    const api = installReactMeasureFilter(perf)
    expect(api).toBeTruthy()
    perf.measure('\u200bChatApp', { start: 0 })
    perf.measure('app-boot', { start: 1 })
    expect(calls).toEqual([['app-boot', { start: 1 }]])
    expect(api.getCount()).toBe(1)
  })
})

describe('startUserTimingGuard', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does not clear while the buffer is under threshold', () => {
    const perf = fakePerf(100)
    const stop = startUserTimingGuard({
      threshold: 50_000,
      intervalMs: 1_000,
      perf,
      getEntries: true,
    })
    vi.advanceTimersByTime(5_000)
    expect(perf.cleared).toBe(0)
    stop()
  })

  it('clears the buffer once it exceeds the threshold, and keeps guarding', () => {
    const perf = fakePerf(60_000)
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const stop = startUserTimingGuard({
      threshold: 50_000,
      intervalMs: 1_000,
      perf,
      getEntries: true,
    })
    vi.advanceTimersByTime(1_000)
    expect(perf.cleared).toBe(1)
    perf.count = 90_000
    vi.advanceTimersByTime(1_000)
    expect(perf.cleared).toBe(2)
    expect(infoSpy).toHaveBeenCalled()
    infoSpy.mockRestore()
    stop()
  })

  it('stop() stops the guard', () => {
    const perf = fakePerf(60_000)
    const stop = startUserTimingGuard({
      threshold: 50_000,
      intervalMs: 1_000,
      perf,
      getEntries: true,
    })
    stop()
    vi.advanceTimersByTime(10_000)
    expect(perf.cleared).toBe(0)
  })
})
