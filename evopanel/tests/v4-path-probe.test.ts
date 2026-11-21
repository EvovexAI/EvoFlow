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

  it('names hub-ahead + notified=0 as the root cause', () => {
    const probe = collectV4PathProbe({
      ...base,
      catchupReason: 'client-behind-resync+notified0',
      catchupNotified: 0,
      catchupAtMs: 999_000,
      subscriberCount: 0,
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

  it('falls back to WIRE_WITHOUT_V4_TIP when tips align but streamMax empty', () => {
    const probe = collectV4PathProbe({
      ...base,
      hubTip: 715,
      feTip: 715,
      streamMax: null,
      lastV4AtMs: 999_500,
    })
    expect(probe.verdict).toBe('WIRE_WITHOUT_V4_TIP')
  })
})
