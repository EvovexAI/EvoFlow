/**
 * Stream resume — manual refresh (F5 / sidebar) and Feishu/IM observer history-watch.
 * Uses messages history-watch (no stream-resume SSE); V4 also refreshEvoflowV4Session each tick.
 */
import { useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react'
import type { ChatSessionRow } from '../chat-types.js'
import {
  reattachRunningSessionIfNeeded,
  abortSessionHistoryWatch,
  type ReattachResult,
  type WsClientReattach,
  type TranscriptResumeAnchor,
} from '../lib/session-reattach.js'
import { dispatchSessionTurnEvent, getSessionRuntime } from '../lib/session-runtime-store.js'
import { shouldSuppressAutoReattach } from '../lib/stream-resume-gate.js'
import { srLog, srWarn } from '../lib/stream-resume-debug.js'
import { ohwLog, ohwWarn } from '../lib/observer-history-watch-debug.js'
import { clearStreamReattachCooldown } from '../lib/stream-reattach-cooldown.js'
import { clearSessionExecutionProbe } from '../lib/session-execution/probe-cache.js'
import { refreshEvoflowV4Session } from '../v4/V4StreamRowsBridge.js'
import { isEvoflowChatV4Enabled } from '../v4/v4Gate.js'

export type UseStreamResumeOptions = {
  selectedSessionKey: string
  sessionsRef: RefObject<readonly ChatSessionRow[]>
  wsClient: WsClientReattach
  reloadRef: RefObject<
    | ((opts?: {
        bypassCache?: boolean
        anchorRunId?: string | null
        dbOnly?: boolean
      }) => Promise<{ transcriptAnchor?: TranscriptResumeAnchor | null } | void>)
    | null
    | undefined
  >
  manualReattachSessionKeyRef: MutableRefObject<string | null>
}

type WsClientWithAbort = WsClientReattach & {
  abortStreamWire?: (sessionKey: string, runId: string) => boolean
}

export function useStreamResume(opts: UseStreamResumeOptions) {
  const { selectedSessionKey, sessionsRef, wsClient, reloadRef, manualReattachSessionKeyRef } = opts

  const [reattachRetryNonce, setReattachRetryNonce] = useState(0)
  const refreshAttachInFlightRef = useRef(false)
  const activeResumeRef = useRef<{ sessionKey: string; runId: string } | null>(null)
  /** Survives React Strict Mode remount — cleared only when reattach finishes. */
  const pendingForceKeyRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const key = selectedSessionKey
    if (!key) return

    if (manualReattachSessionKeyRef.current === key) {
      pendingForceKeyRef.current = key
      manualReattachSessionKeyRef.current = null
    }
    const manualForce = pendingForceKeyRef.current === key
    if (!manualForce) return

    clearStreamReattachCooldown(key)

    if (refreshAttachInFlightRef.current) {
      srLog('reattach skipped — already in flight', { sessionKey: key })
      ohwWarn('useStreamResume skip — already in flight', { sessionKey: key })
      return
    }
    if (shouldSuppressAutoReattach({ sessionKey: key, manualForce: true, observerCatchup: true })) {
      srLog('reattach skipped — live POST stream', { sessionKey: key })
      ohwWarn('useStreamResume skip — suppress (likely owns live POST)', {
        sessionKey: key,
        streamWireSource: getSessionRuntime(key).streamWireSource ?? null,
        turnPhase: getSessionRuntime(key).turnPhase,
      })
      pendingForceKeyRef.current = null
      return
    }

    const sessions = sessionsRef.current ?? []
    const sessionRow = sessions.find((s) => s.sessionKey === key)
    const threadId =
      String(wsClient.getSessionThreadId(key) || '').trim() ||
      String(sessionRow?.threadId || '').trim() ||
      null

    srLog('reattach starting (manual refresh only)', {
      sessionKey: key,
      threadId,
      currentRunId: sessionRow?.currentRunId ?? null,
    })
    ohwLog('useStreamResume start history-watch', {
      sessionKey: key,
      threadId,
      currentRunId: sessionRow?.currentRunId ?? null,
      runStatus: sessionRow?.runStatus ?? null,
      v4: isEvoflowChatV4Enabled(),
      nonce: reattachRetryNonce,
    })

    refreshAttachInFlightRef.current = true
    const resumeRunId = String(
      sessionRow?.currentRunId || getSessionRuntime(key).activeChatRunId || '',
    ).trim()
    if (resumeRunId) {
      activeResumeRef.current = { sessionKey: key, runId: resumeRunId }
    }

    let pollTick = 0
    ;(async () => {
      let result: ReattachResult = 'error'
      try {
        if (cancelled) return
        result = await reattachRunningSessionIfNeeded({
          sessionKey: key,
          wsClient,
          sessionRow: sessionRow
            ? {
                sessionKey: key,
                runStatus: sessionRow.runStatus,
                currentRunId: sessionRow.currentRunId,
                threadId,
              }
            : { threadId },
          reloadHistory: async (runId: string) => {
            pollTick += 1
            const v4 = isEvoflowChatV4Enabled()
            ohwLog('history-watch tick', {
              sessionKey: key,
              runId,
              threadId,
              tick: pollTick,
              v4Refresh: Boolean(v4 && threadId),
              skipLegacyReload: Boolean(v4 && threadId),
            })
            // V4 时间线不吃 host rows：旁观 tick 若仍 dbOnly 拉 /messages + setRows，
            // 会整页重渲（useThreadHistory 对 dbOnly 不走 v4OwnsDisplay 跳过）→ 闪烁。
            // 只刷 V4 catchup；idle 判定走 execution/state，不依赖本轮 messages。
            if (v4 && threadId) {
              refreshEvoflowV4Session(threadId)
              ohwLog('v4 refreshEvoflowV4Session called', { threadId, tick: pollTick })
              return
            }
            ohwWarn('v4 refresh skipped — legacy reload', {
              v4Enabled: v4,
              threadId,
              tick: pollTick,
            })
            return await reloadRef.current?.({
              bypassCache: true,
              anchorRunId: runId,
              dbOnly: true,
            })
          },
          resumeReason: 'shell_refresh',
          manualForce: true,
        })
      } catch (err) {
        srWarn('reattach threw', {
          sessionKey: key,
          error: String(err instanceof Error ? err.message : err),
        })
        ohwWarn('history-watch threw', {
          sessionKey: key,
          error: String(err instanceof Error ? err.message : err),
        })
        dispatchSessionTurnEvent(key, { type: 'REATTACH_FAILED', threadId })
        result = 'error'
      } finally {
        refreshAttachInFlightRef.current = false
        if (activeResumeRef.current?.sessionKey === key) {
          activeResumeRef.current = null
        }
        if (pendingForceKeyRef.current === key) {
          pendingForceKeyRef.current = null
        }
        if (!cancelled) {
          srLog('reattach finished', { sessionKey: key, result })
          ohwLog('history-watch finished', { sessionKey: key, result, ticks: pollTick })
          // reattach 确认会话已结束(idle)：清 probe cache，否则 isSessionExecuting
          // 仍读 stale 的 probe.executing=true，侧栏会永远显示运行中
          if (result === 'idle') {
            clearSessionExecutionProbe(key)
          }
        }
      }
    })()

    return () => {
      cancelled = true
      // Strict Mode remount: keep pendingForceKeyRef so the next effect retries.
      abortSessionHistoryWatch(key)
      ohwLog('useStreamResume cleanup abort watch', {
        sessionKey: key,
        pendingForce: pendingForceKeyRef.current,
      })
      const active = activeResumeRef.current
      if (active?.sessionKey === key && active.runId) {
        try {
          ;(wsClient as WsClientWithAbort).abortStreamWire?.(active.sessionKey, active.runId)
        } catch {
          /* ignore */
        }
        activeResumeRef.current = null
      }
    }
  }, [
    selectedSessionKey,
    sessionsRef,
    wsClient,
    reloadRef,
    manualReattachSessionKeyRef,
    reattachRetryNonce,
  ])

  const markRunCompleted = (_sessionKey: string, _runId: string) => {
    /* no-op: auto reattach disabled */
  }

  return {
    bumpReattachRetry: () => setReattachRetryNonce((n) => n + 1),
    markRunCompleted,
  }
}

export type { ReattachResult }
