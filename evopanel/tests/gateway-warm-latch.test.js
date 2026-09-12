import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  GATEWAY_WARM_LIVENESS_FAIL_STREAK_RESET,
  createWarmLatchState,
  enqueueWarmWait,
  isWarming,
  noteLiveness,
  resetWarmLatch,
} from '../src/lib/gateway-warm-latch.js'

describe('gateway-warm-latch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reuses the same Promise for duplicate keys (not resolve/reject entry)', async () => {
    const state = createWarmLatchState()
    const a = enqueueWarmWait(state, 'GET:/tasks')
    const b = enqueueWarmWait(state, 'GET:/tasks')
    expect(a).toBeTruthy()
    expect(b).toBe(a)
    expect(a).toBeInstanceOf(Promise)
    noteLiveness(state, true)
    await expect(a).resolves.toBeUndefined()
    await expect(b).resolves.toBeUndefined()
  })

  it('does not re-hold on a single liveness false after release', () => {
    const state = createWarmLatchState()
    noteLiveness(state, true)
    expect(isWarming(state)).toBe(false)
    expect(noteLiveness(state, false)).toBe('ignored')
    expect(isWarming(state)).toBe(false)
    expect(enqueueWarmWait(state, 'GET:/tasks')).toBeNull()
  })

  it('resets latch after consecutive liveness failures', () => {
    const state = createWarmLatchState()
    noteLiveness(state, true)
    let last = 'ignored'
    for (let i = 0; i < GATEWAY_WARM_LIVENESS_FAIL_STREAK_RESET; i += 1) {
      last = noteLiveness(state, false)
    }
    expect(last).toBe('reset')
    expect(isWarming(state)).toBe(true)
    expect(enqueueWarmWait(state, 'GET:/tasks')).toBeInstanceOf(Promise)
  })

  it('resetWarmLatch rejects waiters and re-holds new requests', async () => {
    const state = createWarmLatchState()
    const pending = enqueueWarmWait(state, 'GET:/tasks')
    resetWarmLatch(state, 'reload')
    await expect(pending).rejects.toThrow(/warming reset/)
    expect(isWarming(state)).toBe(true)
    const next = enqueueWarmWait(state, 'GET:/tasks')
    expect(next).toBeInstanceOf(Promise)
    noteLiveness(state, true)
    await expect(next).resolves.toBeUndefined()
  })

  it('times out warm waits', async () => {
    const state = createWarmLatchState()
    const pending = enqueueWarmWait(state, 'GET:/x', { timeoutMs: 1000 })
    const assertion = expect(pending).rejects.toThrow(/timeout/)
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
  })
})
