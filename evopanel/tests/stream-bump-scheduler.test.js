import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createStreamBumpScheduler } from '../src/react/lib/stream-bump-scheduler.ts'

describe('createStreamBumpScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces rapid schedules into one bump', () => {
    const bump = vi.fn()
    const scheduler = createStreamBumpScheduler(bump, 100)
    scheduler.schedule()
    scheduler.schedule()
    scheduler.schedule()
    expect(bump).toHaveBeenCalledTimes(0)
    vi.runAllTimers()
    expect(bump).toHaveBeenCalledTimes(1)
    scheduler.dispose()
  })

  it('immediate schedule bumps without waiting', () => {
    const bump = vi.fn()
    const scheduler = createStreamBumpScheduler(bump, 100)
    scheduler.schedule({ immediate: true })
    expect(bump).toHaveBeenCalledTimes(1)
    scheduler.dispose()
  })

  it('cancelPending drops a scheduled coalesced bump', () => {
    const bump = vi.fn()
    const scheduler = createStreamBumpScheduler(bump, 100)
    scheduler.schedule()
    scheduler.cancelPending()
    vi.runAllTimers()
    expect(bump).toHaveBeenCalledTimes(0)
    scheduler.dispose()
  })
})
