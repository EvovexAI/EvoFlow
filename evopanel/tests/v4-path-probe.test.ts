import { describe, expect, it } from 'vitest'
import {
  anomalyFromV4PathProbe,
  collectV4PathProbe,
} from '../src/react/v4/v4-path-probe.ts'

describe('collectV4PathProbe', () => {
  const base = {
    nowMs: 1_000_000,
    tid: 'tid-1',
    executing: true,
    settled: false,
    framesUp: true,
    storeStatus: 'live',
    subscriptionId: 'sub-abc',
    subActive: true,
    stagedCount: 0,
    activeSubCount: 1,
    feTip: 715,
    hubTip: 772,
    hasOptimistic: true,
    windowHasLive: false,
    streamEntries: [] as Array<{
      atMs: number
      channel: string
      sessionId: string
      headline?: string
      jsonText?: string
    }>,
  }

  it('ignores micro tip ghost (live sampling noise Δ<5)', () => {
    const probe = collectV4PathProbe({
      ...base,
      hubTip: 2445,
      feTip: 2447,
      streamMax: 2447,
      lastV4AtMs: 999_500,
      catchupReason: 'live-mirror',
      catchupAtMs: 999_000,
      subscriberCount: 1,
      hasOptimistic: false,
      windowHasLive: true,
    })
    expect(probe.verdict).toBe('OK')
  })

  it('names hub-ahead + notified=0 as the root cause', () => {
    const probe = collectV4PathProbe({
      ...base,
      catchupReason: 'client-behind-resync+notified0',
      catchupNotified: 0,
      catchupAtMs: 999_000,
      // hub 仍有订户但本路 recovery 没人收（对端 sub 错位）；订户=0 走 HUB_SUB_DESYNC
      subscriberCount: 1,
      lastV4AtMs: 990_000,
    })
    expect(probe.verdict).toBe('HUB_AHEAD_NOTIFIED0')
    expect(probe.tipDelta).toBe(57)
    const anomaly = anomalyFromV4PathProbe(probe)
    expect(anomaly?.code).toBe('V4_PATH_HUB_AHEAD_NOTIFIED0')
  })

  it('flags missing store subscription while frames are up', () => {
    const probe = collectV4PathProbe({
      ...base,
      subscriptionId: null,
      subActive: null,
      hubTip: null,
      feTip: 100,
    })
    expect(probe.verdict).toBe('NO_STORE_SUB')
  })

  it('flags staged-but-not-activated subscription', () => {
    const probe = collectV4PathProbe({
      ...base,
      subActive: false,
      stagedCount: 3,
      hubTip: null,
    })
    expect(probe.verdict).toBe('SUB_NOT_ACTIVATED')
  })

  it('flags frames SSE down while executing', () => {
    const probe = collectV4PathProbe({
      ...base,
      framesUp: false,
      hubTip: null,
    })
    expect(probe.verdict).toBe('FRAMES_SSE_DOWN')
  })

  it('tips 对齐 + 近期有 V4 帧时不因乐观泡报 WIRE（正常竞态）', () => {
    const probe = collectV4PathProbe({
      ...base,
      hubTip: 715,
      feTip: 715,
      streamMax: null,
      lastV4AtMs: 999_500,
      catchupReason: 'ready-soft',
      catchupAtMs: 999_000,
      subscriberCount: 1,
    })
    expect(probe.verdict).toBe('OK')
  })

  it('flags WIRE_WITHOUT_V4_TIP when optimistic stall with no recent V4 frames', () => {
    const probe = collectV4PathProbe({
      ...base,
      hubTip: null,
      feTip: 100,
      streamMax: null,
      lastV4AtMs: 980_000, // age 20s ≥ STALE
      catchupReason: 'ready-soft',
      catchupAtMs: 990_000,
      subscriberCount: 1,
      hasOptimistic: true,
      windowHasLive: false,
    })
    expect(probe.verdict).toBe('WIRE_WITHOUT_V4_TIP')
  })

  it('names CATCHUP_NEVER when executing with no hub tip and no V4 frames', () => {
    const probe = collectV4PathProbe({
      ...base,
      hubTip: null,
      feTip: 2155,
      streamMax: null,
      hasOptimistic: true,
      windowHasLive: false,
    })
    expect(probe.verdict).toBe('CATCHUP_NEVER')
  })

  it('names HUB_SUB_DESYNC when hub subscriberCount=0 while FE sub active', () => {
    const probe = collectV4PathProbe({
      ...base,
      hubTip: 1,
      feTip: 2155,
      catchupNotified: 0,
      catchupReason: 'client-stale-resync+notified0',
      catchupAtMs: 999_000,
      subscriberCount: 0,
    })
    expect(probe.verdict).toBe('HUB_SUB_DESYNC')
  })

  it('names FE_TIP_GHOST_NOTIFIED0 when fe tip >> hub, notified=0, hub still has subs', () => {
    const probe = collectV4PathProbe({
      ...base,
      hubTip: 1,
      feTip: 2155,
      catchupNotified: 0,
      catchupReason: 'client-stale-resync+notified0',
      catchupAtMs: 999_000,
      subscriberCount: 1,
    })
    expect(probe.verdict).toBe('FE_TIP_GHOST_NOTIFIED0')
  })
})
