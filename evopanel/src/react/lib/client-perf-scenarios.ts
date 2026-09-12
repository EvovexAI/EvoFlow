/**
 * Deterministic stream workloads for vitest gates and `__evopanelPerf.compareStreamPaths()`.
 */
import {
  bumpStreamDisplayTick,
  getStreamDisplayTick,
  resetStreamDisplayTick,
} from './stream-display-tick.js'
import {
  getLiveStreamSnapshot,
  publishLiveStream,
  resetLiveStreamStoreForTests,
  subscribeLiveStream,
} from './live-stream-store.js'
import {
  disposeLiveStreamUiBatch,
  drainLiveStreamTextBatch,
  scheduleLiveStreamTextPublish,
} from './live-stream-ui.js'
import { isLiveStreamPathEnabled, setLiveStreamPathEnabled } from './stream-live-path-toggle.js'
import {
  getClientPerfSnapshot,
  noteSseTextDelta,
  resetClientPerf,
  setChatSurfaceVisible,
} from './client-perf.js'

export type StreamSimResult = {
  deltaCount: number
  displayTicks: number
  livePublishes: number
  displayTickPerDelta: number
  livePathEnabled: boolean
  chatSurfaceVisible: boolean
  /** liveStream epoch from store */
  liveEpoch: number
}

export function simulateTextOnlyStream(
  deltaCount: number,
  opts?: { livePath?: boolean; sessionKey?: string; chatVisible?: boolean },
): StreamSimResult {
  const livePath = opts?.livePath ?? isLiveStreamPathEnabled()
  const sk = String(opts?.sessionKey || 'perf-sim').trim()
  const chatVisible = opts?.chatVisible ?? true

  resetStreamDisplayTick()
  resetLiveStreamStoreForTests()
  resetClientPerf()
  setLiveStreamPathEnabled(livePath)
  setChatSurfaceVisible(chatVisible)
  disposeLiveStreamUiBatch()

  const unsub =
    livePath && chatVisible ? subscribeLiveStream(sk, () => {}) : null

  let text = ''
  for (let i = 0; i < deltaCount; i += 1) {
    text += 'x'
    noteSseTextDelta()
    if (livePath && chatVisible) {
      scheduleLiveStreamTextPublish(sk)
      publishLiveStream(sk, { text, streaming: true })
    } else if (!livePath) {
      bumpStreamDisplayTick()
    }
  }
  drainLiveStreamTextBatch()
  unsub?.()

  const displayTicks = getStreamDisplayTick()
  const liveEpoch = getLiveStreamSnapshot(sk).epoch
  const snap = getClientPerfSnapshot()

  return {
    deltaCount,
    displayTicks,
    livePublishes: snap.liveStreamPublishes,
    displayTickPerDelta: deltaCount > 0 ? displayTicks / deltaCount : 0,
    livePathEnabled: livePath,
    chatSurfaceVisible: chatVisible,
    liveEpoch,
  }
}

export type StreamPathCompare = {
  deltaCount: number
  live: StreamSimResult
  legacy: StreamSimResult
  displayTickReductionPct: number
  liveMeetsBudget: boolean
}

/** Run live vs legacy side-by-side; primary automated regression signal. */
export function compareStreamPaths(deltaCount = 500): StreamPathCompare {
  const live = simulateTextOnlyStream(deltaCount, { livePath: true })
  const legacy = simulateTextOnlyStream(deltaCount, { livePath: false })
  const reduction =
    legacy.displayTicks > 0
      ? ((legacy.displayTicks - live.displayTicks) / legacy.displayTicks) * 100
      : legacy.displayTicks === live.displayTicks
        ? 0
        : 100
  return {
    deltaCount,
    live,
    legacy,
    displayTickReductionPct: Math.round(reduction * 10) / 10,
    liveMeetsBudget: live.displayTickPerDelta <= 0.05 && live.liveEpoch > 0,
  }
}

export type DualSessionSimResult = {
  switchCount: number
  deltasPerBurst: number
  displayTicks: number
  livePublishes: number
  subscriberNotifies: number
  activeEpochA: number
  activeEpochB: number
}

/**
 * Two sessions stream concurrently; only the active session has a live subscriber
 * (mirrors MessageRow subscription). Background publishes must not notify React.
 */
export function simulateDualSessionStreamSwitch(opts?: {
  deltasPerBurst?: number
  switchCount?: number
}): DualSessionSimResult {
  const skA = 'perf-session-a'
  const skB = 'perf-session-b'
  const deltasPerBurst = opts?.deltasPerBurst ?? 120
  const switchCount = opts?.switchCount ?? 4

  resetStreamDisplayTick()
  resetLiveStreamStoreForTests()
  resetClientPerf()
  setLiveStreamPathEnabled(true)
  setChatSurfaceVisible(true)
  disposeLiveStreamUiBatch()

  let activeSk = skA
  let subscriberNotifies = 0
  let unsub: (() => void) | null = subscribeLiveStream(skA, () => {
    subscriberNotifies += 1
  })

  for (let s = 0; s < switchCount; s += 1) {
    if (activeSk === skA) {
      unsub?.()
      unsub = subscribeLiveStream(skB, () => {
        subscriberNotifies += 1
      })
      activeSk = skB
    } else {
      unsub?.()
      unsub = subscribeLiveStream(skA, () => {
        subscriberNotifies += 1
      })
      activeSk = skA
    }
    for (let i = 0; i < deltasPerBurst; i += 1) {
      publishLiveStream(skA, { text: `A${s}:${i}`, streaming: true })
      publishLiveStream(skB, { text: `B${s}:${i}`, streaming: true })
    }
  }
  unsub?.()

  const snap = getClientPerfSnapshot()
  return {
    switchCount,
    deltasPerBurst,
    displayTicks: getStreamDisplayTick(),
    livePublishes: snap.liveStreamPublishes,
    subscriberNotifies,
    activeEpochA: getLiveStreamSnapshot(skA).epoch,
    activeEpochB: getLiveStreamSnapshot(skB).epoch,
  }
}
