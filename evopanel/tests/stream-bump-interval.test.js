import { describe, expect, it } from 'vitest'
import { emptyStream } from '../src/react/lib/stream-state.ts'
import {
  estimateStreamBumpScore,
  resolveStreamBumpMinIntervalMs,
  STREAM_BUMP_INTERVAL_LARGE_MS,
  STREAM_BUMP_INTERVAL_MEDIUM_MS,
  STREAM_BUMP_INTERVAL_MS,
  STREAM_REASONING_BUMP_INTERVAL_MS,
} from '../src/react/lib/stream-bump-interval.ts'

describe('stream-bump-interval', () => {
  it('exposes a faster reasoning bump interval', () => {
    expect(STREAM_REASONING_BUMP_INTERVAL_MS).toBeLessThan(STREAM_BUMP_INTERVAL_MS)
  })
  it('returns default interval for empty stream', () => {
    const s = emptyStream()
    expect(estimateStreamBumpScore(s)).toBe(0)
    expect(resolveStreamBumpMinIntervalMs(s)).toBe(STREAM_BUMP_INTERVAL_MS)
  })

  it('slows bump interval when live turn is large', () => {
    const s = emptyStream()
    s.turn.openText = 'x'.repeat(90_000)
    expect(resolveStreamBumpMinIntervalMs(s)).toBe(STREAM_BUMP_INTERVAL_MEDIUM_MS)
    s.turn.openText = 'x'.repeat(210_000)
    expect(resolveStreamBumpMinIntervalMs(s)).toBe(STREAM_BUMP_INTERVAL_LARGE_MS)
  })
})
