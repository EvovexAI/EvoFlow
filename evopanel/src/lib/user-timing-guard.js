/**
 * Dev-only watchdog for the User Timing buffer.
 *
 * React 19.2's development build instruments every component render with
 * performance.measure (component tracks, "​"-prefixed names) and Chrome's
 * User Timing buffer is unbounded — streaming-heavy sessions accumulate millions
 * of entries (~GB/h) until the renderer OOM-crashes. See tests/user-timing-guard.test.js.
 *
 * Clearing 50k+ measures synchronously (and even calling getEntriesByType to
 * count them) is itself a 0.5–1s longtask — the stutter users see next to
 * ``[evoflow] user-timing buffer cleared``. Prefer dropping React's ZWSP
 * measures at the source; keep a cheap counter-based clear as a safety net.
 */

/** React 19.2 component tracks use U+200B (zero-width space) name prefix. */
const REACT_MEASURE_ZWSP = '\u200b'

/**
 * Install a one-time filter that no-ops React's per-render ``performance.measure``
 * so the User Timing buffer never fills with component tracks.
 *
 * @param {Performance} [perf]
 * @returns {{ getCount: () => number, resetCount: () => void } | null}
 */
export function installReactMeasureFilter(perf = typeof performance !== 'undefined' ? performance : null) {
  if (!perf || typeof perf.measure !== 'function') return null
  if (perf.__evoflowReactMeasureFiltered) {
    return perf.__evoflowReactMeasureFiltered
  }

  let measureCount = 0
  const origMeasure = perf.measure.bind(perf)
  const origClear = typeof perf.clearMeasures === 'function' ? perf.clearMeasures.bind(perf) : null

  perf.measure = function evoflowFilteredMeasure(name, ...rest) {
    if (typeof name === 'string' && name.length > 0 && name.charAt(0) === REACT_MEASURE_ZWSP) {
      return undefined
    }
    measureCount += 1
    return origMeasure(name, ...rest)
  }

  if (origClear) {
    perf.clearMeasures = function evoflowClearMeasures(...args) {
      measureCount = 0
      return origClear(...args)
    }
  }

  const api = {
    getCount: () => measureCount,
    resetCount: () => {
      measureCount = 0
    },
  }
  Object.defineProperty(perf, '__evoflowReactMeasureFiltered', {
    value: api,
    configurable: true,
  })
  return api
}

/**
 * @param {{
 *   threshold?: number
 *   intervalMs?: number
 *   perf?: Performance & { __evoflowReactMeasureFiltered?: { getCount: () => number, resetCount: () => void } }
 *   getEntries?: boolean
 * }} [opts]
 */
export function startUserTimingGuard({
  threshold = 8_000,
  intervalMs = 5_000,
  perf = typeof performance !== 'undefined' ? performance : null,
  /** @deprecated kept for tests that inject a fake without measure patch */
  getEntries = false,
} = {}) {
  if (!perf || typeof perf.clearMeasures !== 'function') {
    return () => {}
  }

  const counter = installReactMeasureFilter(perf)
  let cleared = 0

  const readCount = () => {
    if (counter) return counter.getCount()
    // Legacy / test path: avoid getEntriesByType on a real huge buffer.
    if (getEntries && typeof perf.getEntriesByType === 'function') {
      return perf.getEntriesByType('measure').length
    }
    return 0
  }

  const timer = setInterval(() => {
    try {
      const count = readCount()
      if (count > threshold) {
        perf.clearMeasures()
        counter?.resetCount()
        cleared += 1
        console.info('[evoflow] user-timing buffer cleared (React 19.2 dev render tracks)', {
          cleared,
          count,
        })
      }
    } catch {
      /* performance API unavailable — nothing to guard */
    }
  }, intervalMs)
  return () => clearInterval(timer)
}
