import { describe, expect, it } from 'vitest'
import {
  FOLD_MIN_HEIGHT_SHRINK_PX,
  isFoldInducedScrollAway,
} from '../src/react/lib/fold-induced-scroll-away.ts'

describe('isFoldInducedScrollAway', () => {
  it('detects reasoning/Exploring fold shrink while streaming', () => {
    expect(
      isFoldInducedScrollAway({
        heightDelta: -420,
        scrollTopDelta: -400,
        distBottom: 380,
        streamActive: true,
      }),
    ).toBe(true)
  })

  it('ignores real user scroll-up without height shrink', () => {
    expect(
      isFoldInducedScrollAway({
        heightDelta: 0,
        scrollTopDelta: -200,
        distBottom: 200,
        streamActive: true,
      }),
    ).toBe(false)
  })

  it('ignores modest height jitter during user scroll-up', () => {
    expect(
      isFoldInducedScrollAway({
        heightDelta: -40,
        scrollTopDelta: -120,
        distBottom: 200,
        streamActive: true,
      }),
    ).toBe(false)
  })

  it('ignores when scrollTop drop far exceeds height shrink', () => {
    expect(
      isFoldInducedScrollAway({
        heightDelta: -130,
        scrollTopDelta: -320,
        distBottom: 280,
        streamActive: true,
      }),
    ).toBe(false)
  })

  it('ignores when still pinned to bottom', () => {
    expect(
      isFoldInducedScrollAway({
        heightDelta: -300,
        scrollTopDelta: -300,
        distBottom: 0,
        streamActive: true,
      }),
    ).toBe(false)
  })

  it('ignores when stream inactive and not settling', () => {
    expect(
      isFoldInducedScrollAway({
        heightDelta: -400,
        scrollTopDelta: -400,
        distBottom: 200,
        streamActive: false,
      }),
    ).toBe(false)
  })

  it('detects fold shrink during post-stream settle window', () => {
    expect(
      isFoldInducedScrollAway({
        heightDelta: -420,
        scrollTopDelta: -400,
        distBottom: 380,
        streamActive: false,
        settlingPostStream: true,
      }),
    ).toBe(true)
  })

  it('never snaps when user already scrolled away', () => {
    expect(
      isFoldInducedScrollAway({
        heightDelta: -420,
        scrollTopDelta: -400,
        distBottom: 380,
        streamActive: true,
        userScrollAwayIntent: true,
      }),
    ).toBe(false)
  })

  it(`requires at least ${FOLD_MIN_HEIGHT_SHRINK_PX}px shrink`, () => {
    expect(
      isFoldInducedScrollAway({
        heightDelta: -(FOLD_MIN_HEIGHT_SHRINK_PX - 1),
        scrollTopDelta: -(FOLD_MIN_HEIGHT_SHRINK_PX - 1),
        distBottom: 200,
        streamActive: true,
      }),
    ).toBe(false)
  })
})
