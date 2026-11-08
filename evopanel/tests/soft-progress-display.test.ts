import { describe, expect, it } from 'vitest'
import {
  parseProgressStartMs,
  softDisplayProgressPercent,
} from '../src/lib/soft-progress-display.js'

describe('softDisplayProgressPercent', () => {
  it('creeps above the dispatch floor while running', () => {
    const pct = softDisplayProgressPercent({
      stored: 10,
      status: 'in_progress',
      runningForMs: 60_000,
    })
    expect(pct).toBeGreaterThan(10)
    expect(pct).toBeLessThanOrEqual(92)
  })

  it('approaches but does not exceed the soft ceiling', () => {
    const pct = softDisplayProgressPercent({
      stored: 10,
      status: 'running',
      runningForMs: 3_600_000,
    })
    expect(pct).toBeGreaterThanOrEqual(80)
    expect(pct).toBeLessThanOrEqual(92)
  })

  it('never drops below a worker-reported floor', () => {
    const pct = softDisplayProgressPercent({
      stored: 55,
      status: 'executing',
      runningForMs: 15_000,
    })
    expect(pct).toBeGreaterThanOrEqual(55)
  })

  it('snaps to 100 on completed', () => {
    expect(
      softDisplayProgressPercent({ stored: 10, status: 'completed', runningForMs: 0 }),
    ).toBe(100)
  })

  it('keeps stored value when pending', () => {
    expect(
      softDisplayProgressPercent({ stored: 0, status: 'pending', runningForMs: 0 }),
    ).toBe(0)
  })
})

describe('parseProgressStartMs', () => {
  it('parses ISO and epoch', () => {
    expect(parseProgressStartMs('2026-11-08T12:00:00Z')).toBe(
      Date.parse('2026-11-08T12:00:00Z'),
    )
    expect(parseProgressStartMs(1_700_000_000_000)).toBe(1_700_000_000_000)
  })
})
