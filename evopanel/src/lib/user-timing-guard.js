/**
 * Dev-only watchdog for the User Timing buffer.
 *
 * React 19.2's development build instruments every component render with
 * performance.measure (component tracks, "​"-prefixed names) and Chrome's
 * User Timing buffer is unbounded — streaming-heavy sessions accumulate millions
 * of entries (~GB/h) until the renderer OOM-crashes. See tests/user-timing-guard.test.js.
 */
export function startUserTimingGuard({ threshold = 50_000, intervalMs = 30_000, perf = performance } = {}) {
  if (!perf || typeof perf.getEntriesByType !== 'function' || typeof perf.clearMeasures !== 'function') {
    return () => {}
  }
  let cleared = 0
  const timer = setInterval(() => {
    try {
      const count = perf.getEntriesByType('measure').length
      if (count > threshold) {
        perf.clearMeasures()
        cleared++
        console.info('[evoflow] user-timing buffer cleared (React 19.2 dev render tracks)', { cleared, count })
      }
    } catch {
      /* performance API unavailable — nothing to guard */
    }
  }, intervalMs)
  return () => clearInterval(timer)
}
