/**
 * Regression: ws-client bufferedUnanchoredMessagesRoots accumulates one full messages
 * root per event while the stream is unanchored — a long orchestration run whose values
 * snapshot never anchors pushes MB-scale roots for the whole run (GB-scale retention).
 * The buffer must be bounded: drop oldest, report how many were dropped.
 */
import { describe, expect, it } from 'vitest'
import { pushBounded } from '../src/lib/bounded-buffer.js'

describe('pushBounded', () => {
  it('keeps only the newest max items, dropping the oldest', () => {
    const buf = []
    for (let i = 0; i < 10; i++) pushBounded(buf, { i }, 4)
    expect(buf).toHaveLength(4)
    expect(buf.map((x) => x.i)).toEqual([6, 7, 8, 9])
  })

  it('returns the number of dropped items', () => {
    const buf = []
    expect(pushBounded(buf, 'a', 2)).toBe(0)
    expect(pushBounded(buf, 'b', 2)).toBe(0)
    expect(pushBounded(buf, 'c', 2)).toBe(1)
    expect(pushBounded(buf, 'd', 2)).toBe(1)
    expect(buf).toEqual(['c', 'd'])
  })

  it('does nothing special when under the cap', () => {
    const buf = []
    expect(pushBounded(buf, 'x', 8)).toBe(0)
    expect(buf).toEqual(['x'])
  })
})
