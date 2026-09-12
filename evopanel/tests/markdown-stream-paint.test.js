import { describe, expect, it } from 'vitest'
import {
  resolveReasoningStreamPaintMinMs,
  resolveStreamPlainPaintMinMs,
  shouldStreamReasoningAsPlain,
  shouldUseStreamingPlainMarkdown,
  STREAM_PLAIN_PAINT_TAIL_MS,
  STREAM_PAINT_MIN_MS,
  STREAM_PAINT_MIN_MEDIUM_MS,
  STREAM_REASONING_PAINT_MIN_MS,
  STREAM_REASONING_PAINT_MEDIUM_MS,
} from '../src/react/lib/markdown-stream-paint.ts'

describe('reasoning stream paint', () => {
  it('uses fast plain paint intervals for reasoning', () => {
    expect(resolveReasoningStreamPaintMinMs(100)).toBe(STREAM_REASONING_PAINT_MIN_MS)
    expect(resolveReasoningStreamPaintMinMs(9000)).toBe(STREAM_REASONING_PAINT_MEDIUM_MS)
  })

  it('always streams reasoning as plain text', () => {
    expect(shouldStreamReasoningAsPlain(100)).toBe(true)
    expect(shouldStreamReasoningAsPlain(50_000)).toBe(true)
  })
})

describe('body stream paint', () => {
  it('always streams assistant body as plain text during live turns', () => {
    expect(shouldUseStreamingPlainMarkdown(100)).toBe(true)
    expect(shouldUseStreamingPlainMarkdown(50_000)).toBe(true)
  })

  it('uses plain paint intervals for live body', () => {
    expect(resolveStreamPlainPaintMinMs(100)).toBe(STREAM_PAINT_MIN_MS)
    expect(resolveStreamPlainPaintMinMs(7000)).toBe(STREAM_PAINT_MIN_MEDIUM_MS)
    expect(resolveStreamPlainPaintMinMs(20_000)).toBe(STREAM_PLAIN_PAINT_TAIL_MS)
  })
})
