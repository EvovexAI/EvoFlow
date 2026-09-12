/**
 * Desktop gateway warm latch: hold API traffic until liveness, and re-hold after reload.
 * Pure state machine (no Tauri) so unit tests can cover the cold-start race bugs.
 */

const WARMING_TIMEOUT_MS = 90_000
const LIVENESS_FAIL_STREAK_RESET = 3

/**
 * @typedef {{
 *   livenessOk: boolean,
 *   livenessResolved: boolean,
 *   failStreak: number,
 *   pending: Map<string, { promise: Promise<void>, resolve: () => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> }>,
 * }} WarmLatchState
 */

/** @returns {WarmLatchState} */
export function createWarmLatchState() {
  return {
    livenessOk: false,
    livenessResolved: false,
    failStreak: 0,
    pending: new Map(),
  }
}

/** Current latch not released (cold start or post-reload). */
export function isWarming(state) {
  return !state.livenessOk
}

/**
 * @param {WarmLatchState} state
 * @param {string} key
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<void> | null} null = already live, do not wait
 */
export function enqueueWarmWait(state, key, opts = {}) {
  if (state.livenessOk) return null
  const existing = state.pending.get(key)
  if (existing) return existing.promise

  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  const timeoutMs = Math.max(1_000, Number(opts.timeoutMs) || WARMING_TIMEOUT_MS)
  const timer = setTimeout(() => {
    state.pending.delete(key)
    reject(new Error('gateway warming timeout'))
  }, timeoutMs)
  state.pending.set(key, {
    promise,
    resolve: () => {
      clearTimeout(timer)
      resolve()
    },
    reject: (err) => {
      clearTimeout(timer)
      reject(err)
    },
    timer,
  })
  return promise
}

/**
 * @param {WarmLatchState} state
 * @param {boolean} ok
 * @returns {'released' | 'ignored' | 'held' | 'reset'}
 */
export function noteLiveness(state, ok) {
  if (ok) {
    state.failStreak = 0
    state.livenessOk = true
    if (!state.livenessResolved) {
      state.livenessResolved = true
    }
    for (const entry of state.pending.values()) {
      entry.resolve()
    }
    state.pending.clear()
    return 'released'
  }

  state.failStreak += 1
  if (state.livenessResolved && state.failStreak >= LIVENESS_FAIL_STREAK_RESET) {
    resetWarmLatch(state, 'liveness_fail_streak')
    return 'reset'
  }
  if (state.livenessResolved) {
    return 'ignored'
  }
  state.livenessOk = false
  return 'held'
}

/**
 * Drop release flags so subsequent API calls wait again (reload / crash window).
 * @param {WarmLatchState} state
 * @param {string} [reason]
 */
export function resetWarmLatch(state, reason = 'reset') {
  state.livenessOk = false
  state.livenessResolved = false
  state.failStreak = 0
  const err = new Error(`gateway warming reset: ${reason}`)
  for (const entry of state.pending.values()) {
    entry.reject(err)
  }
  state.pending.clear()
}

export const GATEWAY_WARM_LIVENESS_FAIL_STREAK_RESET = LIVENESS_FAIL_STREAK_RESET
export const GATEWAY_WARMING_TIMEOUT_MS = WARMING_TIMEOUT_MS
