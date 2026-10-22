/**
 * Stale turn-busy 看门狗（两个 effect）：
 *   1. 选中会话：90s 无事件 → 清 busy（事件驱动清理的兜底）
 *   2. 全局轮询：15s 扫描所有 busy 会话，45s 无事件且后端确认不在跑 → 强清
 *
 * Extracted from ChatApp.tsx (P74). 逻辑逐行搬运，未改行为。
 */
import { useEffect } from 'react'
import type { MutableRefObject } from 'react'
import {
  fetchSessionRuntimeStatus,
  invalidateSessionRuntimeStatusCache,
  maybeClearTurnSendingState,
  type WsClientReattach,
} from '../../lib/session-reattach.js'
import {
  getSessionRuntime,
  listBusySessionKeys,
} from '../../lib/session-runtime-store.js'
import { logStreamStop } from '../../lib/stream-stop-log.js'
import { parseTurnTimestampMs } from '../../lib/turn-timing.js'
import { turnBusyForSession } from '../utils/session-busy.js'

type SessionRuntime = ReturnType<typeof getSessionRuntime>

export type UseStaleTurnWatchdogsCtx = {
  /** 当前选中会话是否 turn busy（第一个看门狗的开关） */
  selectedTurnBusy: boolean
  selectedSessionKey: string
  sessionsRef: MutableRefObject<Array<{ sessionKey?: string; currentTurnStartedAt?: unknown }>>
  clearTurnSendingState: (sk: string, rt: SessionRuntime, isBackground: boolean) => void
  /** attach 已尝试记录（90s 看门狗成功后写入，避免重复 attach） */
  refreshAttachAttemptedRef: MutableRefObject<Record<string, string>>
  /** wsClient 透传给 maybeClearTurnSendingState（需 ensureChatThread/resumeChatStream） */
  wsClient: WsClientReattach
}

/** 选中会话：90s 无事件 → 清 busy。 */
export function useSelectedStaleTurnWatchdog(ctx: UseStaleTurnWatchdogsCtx): void {
  const {
    selectedTurnBusy,
    selectedSessionKey,
    sessionsRef,
    clearTurnSendingState,
    refreshAttachAttemptedRef,
    wsClient,
  } = ctx

  useEffect(() => {
    if (!selectedTurnBusy) return
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return
    let cancelled = false
    const timer = window.setInterval(() => {
      if (cancelled || !turnBusyForSession(sk)) return
      const rt = getSessionRuntime(sk)
      const last =
        Number(rt.lastEventAt || 0) ||
        parseTurnTimestampMs(
          sessionsRef.current.find((s) => String(s.sessionKey || '') === sk)?.currentTurnStartedAt,
        ) ||
        0
      if (!last) return
      if (Date.now() - last < 90000) return
      void import('../../../lib/poll-loop-log.js').then(({ logPollLoopEnd }) => {
        logPollLoopEnd('stale_sending_watchdog', { sessionKey: sk, silentMs: Date.now() - last })
      })
      void maybeClearTurnSendingState({
        sessionKey: sk,
        wsClient,
        onClear: () => clearTurnSendingState(sk, rt, false),
        onResume: () => {
          /* 续流仅用户刷新触发 */
        },
      }).then((result) => {
        if (result === 'cleared' || result === 'forced') {
          logStreamStop({
            sessionKey: sk,
            runId: rt.activeChatRunId || rt.stream.runId,
            trigger: 'stale_sending_watchdog',
            hasEndMarker: false,
            detail: {
              result,
              silentMs: Date.now() - last,
              turnPhase: rt.turnPhase,
              note: '前端 90s 无事件后清 busy（非用户点停止）',
            },
          })
          void fetchSessionRuntimeStatus(sk).then((st) => {
            if (st?.attachRecommended === false) {
              refreshAttachAttemptedRef.current[sk] = String(
                st.threadId || wsClient.getSessionThreadId(sk) || '',
              )
            }
          })
        }
      })
    }, 30000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [selectedTurnBusy, selectedSessionKey, clearTurnSendingState])
}

/**
 * 全局 stale busy 轮询兜底：不依赖事件，每 15s 扫描所有 busy 会话（含非选中）。
 * 对 lastEventAt 超 45s 无新事件的会话，查 DB 确认是否真的还在运行；
 * DB 说不在运行就强制清理 turn 状态。这是对事件驱动清理的兜底——
 * 事件可能丢失/拦截/跳过，但轮询不会。
 */
export function useGlobalStaleBusyPoll(ctx: UseStaleTurnWatchdogsCtx): void {
  const { clearTurnSendingState, wsClient } = ctx

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      const busyKeys = listBusySessionKeys()
      for (const sk of busyKeys) {
        const rt = getSessionRuntime(sk)
        const last = Number(rt.lastEventAt || 0)
        if (!last) continue
        if (Date.now() - last < 45000) continue
        invalidateSessionRuntimeStatusCache(sk)
        const silentMs = Date.now() - last
        const runIdBefore = rt.activeChatRunId || rt.stream.runId
        void maybeClearTurnSendingState({
          sessionKey: sk,
          wsClient,
          onClear: () => {
            clearTurnSendingState(sk, rt, true)
            logStreamStop({
              sessionKey: sk,
              runId: runIdBefore,
              trigger: 'stale_busy_poll_clear',
              hasEndMarker: false,
              detail: {
                silentMs,
                turnPhase: rt.turnPhase,
                note: '全局 45s 无事件且后端确认不在跑后清 busy',
              },
            })
          },
          onResume: () => {
            /* 续流仅用户刷新触发 */
          },
        })
      }
    }, 15000)
    return () => window.clearInterval(timer)
  }, [clearTurnSendingState])
}
