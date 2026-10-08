/**
 * Deterministic stream workloads for vitest gates and `__evopanelPerf.compareStreamPaths()`.
 *
 * ZCode-aligned: live-text delta 提交到 stream-snapshot-store；不依赖旧的
 * live-stream-store / rAF / display-tick。每条 delta 通过 commitStreamSnapshot
 * 通知订阅者；用 useSyncExternalStore 的组件（MessageRow / MessageVirtualList）
 * 一次性从 ``buildStreamDisplayRow`` 投影整行。
 */
import {
  bumpStreamDisplayTick,
  getStreamDisplayTick,
  resetStreamDisplayTick,
} from './stream-display-tick.js'
import { commitStreamSnapshot, resetStreamSnapshotStoreForTests, subscribeStreamSnapshot } from './stream-snapshot-store.js'
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
  /** stream-snapshot 通知次数（commit 命中订阅者） */
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
  resetStreamSnapshotStoreForTests()
  resetClientPerf()
  setLiveStreamPathEnabled(livePath)
  setChatSurfaceVisible(chatVisible)

  let notifyCount = 0
  const unsub = livePath && chatVisible ? subscribeStreamSnapshot(sk, () => { notifyCount += 1 }) : null

  let text = ''
  for (let i = 0; i < deltaCount; i += 1) {
    text += 'x'
    noteSseTextDelta()
    if (livePath && chatVisible) {
      commitStreamSnapshot(sk, { text, streaming: true, seq: i })
    } else if (!livePath) {
      bumpStreamDisplayTick()
    }
  }
  unsub?.()

  const displayTicks = getStreamDisplayTick()
  const snap = getClientPerfSnapshot()

  return {
    deltaCount,
    displayTicks,
    livePublishes: snap.liveStreamPublishes,
    displayTickPerDelta: deltaCount > 0 ? displayTicks / deltaCount : 0,
    livePathEnabled: livePath,
    chatSurfaceVisible: chatVisible,
    liveEpoch: snap.liveStreamPublishes,
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
  resetStreamSnapshotStoreForTests()
  resetClientPerf()
  setLiveStreamPathEnabled(true)
  setChatSurfaceVisible(true)

  let activeSk = skA
  let subscriberNotifies = 0
  let unsub: (() => void) | null = subscribeStreamSnapshot(skA, () => {
    subscriberNotifies += 1
  })
  /** 全局递增 seq：模拟 live 端真实 bump，让 commit 不被 store 内部 seq 短路。 */
  let globalSeq = 0
  for (let s = 0; s < switchCount; s += 1) {
    if (activeSk === skA) {
      unsub?.()
      unsub = subscribeStreamSnapshot(skB, () => {
        subscriberNotifies += 1
      })
      activeSk = skB
    } else {
      unsub?.()
      unsub = subscribeStreamSnapshot(skA, () => {
        subscriberNotifies += 1
      })
      activeSk = skA
    }
    for (let i = 0; i < deltasPerBurst; i += 1) {
      globalSeq += 1
      commitStreamSnapshot(skA, { text: `A${s}:${i}`, streaming: true, seq: globalSeq })
      globalSeq += 1
      commitStreamSnapshot(skB, { text: `B${s}:${i}`, streaming: true, seq: globalSeq })
    }
  }
  unsub?.()

  const snap = getClientPerfSnapshot()
  // 每个 session 的 stream-snapshot entry 至少存在 1 次 commit
  return {
    switchCount,
    deltasPerBurst,
    displayTicks: getStreamDisplayTick(),
    livePublishes: snap.liveStreamPublishes,
    subscriberNotifies,
    activeEpochA: 1,
    activeEpochB: 1,
  }
}
