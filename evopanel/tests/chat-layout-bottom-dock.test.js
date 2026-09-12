import { describe, expect, it } from 'vitest'
import {
  applyBottomAreaHeightDelta,
  clampBottomDockHeight,
} from '../src/lib/chat-layout-storage.ts'

describe('clampBottomDockHeight', () => {
  it('leaves room for the message column', () => {
    // 主列 800px → 最多约 440；视口 1000 → 最多 500；取更严的
    expect(clampBottomDockHeight(700, 1000, 800)).toBe(440)
  })

  it('respects minimum height', () => {
    expect(clampBottomDockHeight(20, 1000, 800)).toBe(100)
  })
})

describe('applyBottomAreaHeightDelta', () => {
  it('grows when dragging upward (negative delta)', () => {
    expect(applyBottomAreaHeightDelta(160, -80, 140, 1000, 800)).toBe(240)
  })

  it('returns null when near natural height', () => {
    expect(applyBottomAreaHeightDelta(160, 40, 140, 1000, 800)).toBeNull()
  })
})
