import { describe, expect, it } from 'vitest'
import {
  applyLiveStreamOverlay,
} from '../src/react/lib/apply-live-stream-overlay.ts'
import {
  liveStreamDisplayTail,
  resolveStreamPlainPaintMinMs,
  STREAM_PLAIN_DISPLAY_MAX_CHARS,
  STREAM_PLAIN_PAINT_TAIL_MS,
  STREAM_PAINT_MIN_MEDIUM_MS,
  STREAM_PAINT_MIN_MS,
  STREAM_REASONING_DISPLAY_MAX_CHARS,
  streamingPlainDisplayText,
} from '../src/react/lib/markdown-stream-paint.ts'

describe('live stream display tail', () => {
  it('passes through short text', () => {
    expect(liveStreamDisplayTail('hello')).toBe('hello')
    expect(streamingPlainDisplayText('hello')).toBe('hello')
  })

  it('caps live body to STREAM_PLAIN_DISPLAY_MAX_CHARS', () => {
    const raw = 'x'.repeat(50_000)
    const out = streamingPlainDisplayText(raw)
    expect(out.length).toBeLessThanOrEqual(STREAM_PLAIN_DISPLAY_MAX_CHARS)
    expect(out).toContain('前文已省略')
    expect(out.endsWith('x'.repeat(32))).toBe(true)
  })

  it('overlay tail-windows huge streaming body so React row stays bounded', () => {
    const row = {
      role: '_stream',
      text: 'seed',
      segments: [{ kind: 'text', text: 'seed' }],
      tools: [],
    }
    const huge = 'Δ'.repeat(40_000)
    const out = applyLiveStreamOverlay(row, {
      sessionKey: 's',
      text: huge,
      reasoning: 'r'.repeat(20_000),
      streaming: true,
      epoch: 9,
    })
    expect(out.text.length).toBeLessThanOrEqual(STREAM_PLAIN_DISPLAY_MAX_CHARS)
    expect(String(out.reasoningPreview || '').length).toBeLessThanOrEqual(
      STREAM_REASONING_DISPLAY_MAX_CHARS,
    )
    expect(out.segments?.find((s) => s.kind === 'text')?.text).toBe(out.text)
  })

  it('does not tail when overlay is not streaming', () => {
    const body = 'z'.repeat(20_000)
    const out = applyLiveStreamOverlay(
      { role: '_stream', text: '', segments: [], tools: [] },
      { sessionKey: 's', text: body, reasoning: '', streaming: false, epoch: 3 },
    )
    expect(out.text).toBe(body)
  })
})

describe('plain paint tiers include tail window', () => {
  it('steps 120 → 220 → 520 once past display tail', () => {
    expect(resolveStreamPlainPaintMinMs(100)).toBe(STREAM_PAINT_MIN_MS)
    expect(resolveStreamPlainPaintMinMs(7000)).toBe(STREAM_PAINT_MIN_MEDIUM_MS)
    expect(resolveStreamPlainPaintMinMs(20_000)).toBe(STREAM_PLAIN_PAINT_TAIL_MS)
  })
})
