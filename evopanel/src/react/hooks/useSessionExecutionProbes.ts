import { useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  clearSessionExecutionProbe,
  fetchAndCacheSessionExecutionState,
  getSessionExecutionProbeEpoch,
  refreshBackgroundExecutionProbes,
  subscribeSessionExecutionProbes,
} from '../lib/session-execution/probe-cache.js'
import {
  getSessionGoalStateEpoch,
  subscribeSessionGoalState,
} from '../lib/session-execution/goal-mode-state.js'
import {
  dispatchSessionTurnEvent,
  getSessionRuntime,
  isTurnBusy,
} from '../lib/session-runtime-store.js'
import { isSessionRecoveryCooldownActive } from '../lib/stream-reattach-cooldown.js'
import type { SessionExecutionRow } from '../lib/session-execution/types.js'

const PROBE_INTERVAL_MS = 20_000

/** 前台会话状态守卫轮询间隔（ms）--停留的会话若本地显示运行中，定时查后端纠正 */
const FOREGROUND_GUARD_INTERVAL_MS = 20_000
/** 首次守卫延迟（ms）--避免与刚发出的请求竞争 */
const FOREGROUND_GUARD_FIRST_DELAY_MS = 8_000

function pageIsHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

export function useSessionExecutionProbes(
  sessions: SessionExecutionRow[],
  selectedSessionKey: string | null | undefined,
): number {
  const probeEpoch = useSyncExternalStore(subscribeSessionExecutionProbes, getSessionExecutionProbeEpoch)
  const goalEpoch = useSyncExternalStore(subscribeSessionGoalState, getSessionGoalStateEpoch)
  const epoch = probeEpoch + goalEpoch

  /** 仅 runStatus / runId 变化时重跑，避免 refreshSessions 换引用导致重复探测 */
  const sessionsProbeKey = useMemo(
    () =>
      sessions
        .map((s) =>
          [
            String(s.sessionKey || '').trim(),
            String(s.runStatus || '').trim().toLowerCase(),
            String(s.currentRunId || '').trim(),
          ].join(':'),
        )
        .filter(Boolean)
        .join('|'),
    [sessions],
  )

  useEffect(() => {
    let cancelled = false
    let id = 0
    const run = () => {
      if (cancelled || pageIsHidden()) return
      void refreshBackgroundExecutionProbes(sessions, {
        foregroundKey: String(selectedSessionKey || '').trim() || null,
      })
    }
    const start = () => {
      if (id) window.clearInterval(id)
      run()
      id = window.setInterval(run, PROBE_INTERVAL_MS)
    }
    const onVisibility = () => {
      if (pageIsHidden()) {
        if (id) {
          window.clearInterval(id)
          id = 0
        }
        return
      }
      start()
    }
    start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      if (id) window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [sessionsProbeKey, selectedSessionKey, sessions])

  /**
   * 前台会话状态守卫：停留的会话如果本地显示运行中(isTurnBusy)，
   * 定时查后端 execution/state；后端确认已结束则清 probe cache + dispatch TURN_IDLE，
   * 让侧栏运行状态自动归位。
   *
   * 背景：refreshBackgroundExecutionProbes 刻意跳过 foregroundKey，
   * useRunningSessionSummaries 也排除 selectedSessionKey，
   * 导致前台会话 SSE 断连后卡 busy 时无人查后端，状态永不自动纠正。
   */
  useEffect(() => {
    const fg = String(selectedSessionKey || '').trim()
    if (!fg) return

    let cancelled = false
    let id = 0
    let firstTimer = 0

    const checkForeground = async () => {
      if (cancelled || pageIsHidden()) return
      const rt = getSessionRuntime(fg)
      if (!isTurnBusy(rt)) return // 本地不忙，无需查后端
      // 用户刚点停止的 recovery 冷却期跳过（LangGraph 取消有延迟，DB 可能仍残留 running）
      if (isSessionRecoveryCooldownActive(fg)) return

      try {
        const probe = await fetchAndCacheSessionExecutionState(fg)
        if (cancelled || !probe) return
        const backendDone = !probe.executing && !probe.goalActive
        if (backendDone) {
          // 后端确认已结束：清 probe cache + dispatch TURN_IDLE 归位侧栏运行状态
          clearSessionExecutionProbe(fg)
          dispatchSessionTurnEvent(fg, { type: 'TURN_IDLE' })
        }
      } catch {
        /* best-effort */
      }
    }

    const start = () => {
      if (id) window.clearInterval(id)
      if (firstTimer) window.clearTimeout(firstTimer)
      firstTimer = window.setTimeout(checkForeground, FOREGROUND_GUARD_FIRST_DELAY_MS)
      id = window.setInterval(checkForeground, FOREGROUND_GUARD_INTERVAL_MS)
    }
    const onVisibility = () => {
      if (pageIsHidden()) {
        if (id) {
          window.clearInterval(id)
          id = 0
        }
        if (firstTimer) {
          window.clearTimeout(firstTimer)
          firstTimer = 0
        }
        return
      }
      start()
    }
    start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      if (id) window.clearInterval(id)
      if (firstTimer) window.clearTimeout(firstTimer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [selectedSessionKey])

  return epoch
}
