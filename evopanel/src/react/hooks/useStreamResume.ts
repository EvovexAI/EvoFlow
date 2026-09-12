/**
 * Stream resume — only on explicit user refresh (F5 / sidebar refresh button).
 * Uses messages history-watch (no stream-resume SSE).
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
import { clearStreamReattachCooldown } from '../lib/stream-reattach-cooldown.js'
import { clearSessionExecutionProbe } from '../lib/session-execution/probe-cache.js'

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

  useEffect(() => {
    let cancelled = false
    const key = selectedSessionKey
    if (!key) return

    const manualForce = manualReattachSessionKeyRef.current === key
    if (!manualForce) return

    manualReattachSessionKeyRef.current = null
    clearStreamReattachCooldown(key)
    refreshAttachInFlightRef.current = false

    if (refreshAttachInFlightRef.current) {
      srLog('reattach skipped — already in flight', { sessionKey: key })
      return
    }
    if (shouldSuppressAutoReattach({ sessionKey: key, manualForce: true })) {
      srLog('reattach skipped — live POST stream', { sessionKey: key })
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

    refreshAttachInFlightRef.current = true
    const resumeRunId = String(
      sessionRow?.currentRunId || getSessionRuntime(key).activeChatRunId || '',
    ).trim()
    if (resumeRunId) {
      activeResumeRef.current = { sessionKey: key, runId: resumeRunId }
    }

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
            return await reloadRef.current?.({ bypassCache: true, anchorRunId: runId, dbOnly: true })
          },
          resumeReason: 'shell_refresh',
          manualForce: true,
        })
      } catch (err) {
        srWarn('reattach threw', {
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
        if (!cancelled) {
          srLog('reattach finished', { sessionKey: key, result })
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
      abortSessionHistoryWatch(key)
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
