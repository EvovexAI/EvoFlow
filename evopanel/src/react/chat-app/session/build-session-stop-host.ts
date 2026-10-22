/**
 * Build SessionStopHost callbacks for composer / sidebar stop.
 * Extracted from ChatApp.tsx (P72).
 */
import type { Dispatch, SetStateAction } from 'react'
import { toast } from '../../../components/toast.js'
import { restorePendingInjects } from '../../../lib/ws-client.js'
import { isTaskNotificationInject } from '../../../lib/chat-normalize.js'
import { mergeInterruptedComposerDraft } from '../../lib/merge-interrupted-composer-draft.js'
import {
  getSessionRuntime,
  resetRuntimeStream,
  rtAddStoppedRun,
} from '../../lib/session-runtime-store.js'
import {
  clearSessionExecutionStateForEnded,
  patchSessionListRunEnded,
  type SessionStopHost,
} from '../../lib/session-execution/index.js'
import { clearThreadPanelActivity } from '../thread-panel/state.js'
import type { ChatSessionRow, DisplayRow, StreamState, ThreadPanelState } from '../../chat-types.js'

export type BuildSessionStopHostCtx = {
  selectedSessionKey: string
  sessionRef: { current: string }
  streamRef: { current: StreamState }
  streamHealthRef: { current: unknown }
  toolApprovalResolvedIdsRef: { current: Set<string> }
  userInitiatedStopRef: { current: boolean }
  interruptSendSteersRef: { current: boolean }
  pendingSendQueueRef: { current: Array<{ text?: string }> }
  midTurnInjectRef: { current: Array<{ sessionKey?: string }> }
  activeChatRunIdRef: { current: string | null }
  composerTextRef: { current: string }
  refreshSessionsRef: { current: (() => void | Promise<unknown>) | null | undefined }
  setStreamHealth: (v: null) => void
  setSubagentDockTasks: (v: Record<string, unknown>) => void
  setThreadPanelState: Dispatch<SetStateAction<ThreadPanelState>>
  setExpectedChatRunId: (sk: string, rid: string | null) => void
  setRows: Dispatch<SetStateAction<DisplayRow[]>>
  setPendingSteers: Dispatch<SetStateAction<Array<{ sessionKey: string }>>>
  setPendingSendQueue: Dispatch<SetStateAction<Array<{ text?: string }>>>
  setSessions: Dispatch<SetStateAction<ChatSessionRow[]>>
  pushComposerText: (text: string) => void
  reloadHistoryFromDb: (opts: { dbOnly: boolean; bypassCache: boolean }) => void
  scheduleBump: (opts?: { immediate?: boolean }) => void
  deleteLiveRunSnapshotBestEffort: (sk: string) => void
}

export function buildSessionStopHost(ctx: BuildSessionStopHostCtx): SessionStopHost {
  return {
    isForegroundSession: (sk) =>
      sk === ctx.sessionRef.current || sk === String(ctx.selectedSessionKey || '').trim(),
    onUserStopStarted: () => {
      ctx.userInitiatedStopRef.current = true
    },
    onUserStopFinished: () => {
      ctx.userInitiatedStopRef.current = false
    },
    onForegroundStopComplete: ({ sessionKey: sk }) => {
      ctx.toolApprovalResolvedIdsRef.current = new Set()
      const rt = getSessionRuntime(sk)
      resetRuntimeStream(rt, ctx.streamRef)
      ctx.setStreamHealth(null)
      ctx.streamHealthRef.current = null
      ctx.setSubagentDockTasks({})
      ctx.setThreadPanelState(clearThreadPanelActivity)
      ctx.setExpectedChatRunId(sk, null)
      ctx.activeChatRunIdRef.current = null
      ctx.setRows([...getSessionRuntime(sk).rows])
      // Esc/立即发送: interrupt path already captured steer texts and will handleSend.
      // Only pop server queue here (discard); do NOT push into pendingSendQueue or we
      // get a duplicate user bubble when busy→idle also flushes the queue.
      if (ctx.interruptSendSteersRef.current) {
        ctx.interruptSendSteersRef.current = false
        ctx.setPendingSteers((prev) => prev.filter((s) => s.sessionKey !== sk))
        ctx.midTurnInjectRef.current = ctx.midTurnInjectRef.current.filter(
          (x) => x.sessionKey !== sk,
        )
        void restorePendingInjects(sk).catch(() => {})
        return
      }
      // runtime interrupt restore: merge steers + queue into composer (not scattered list rows)
      const queueTexts = ctx.pendingSendQueueRef.current
        .map((x) => String(x.text || '').trim())
        .filter(Boolean)
      ctx.setPendingSendQueue([])
      ctx.setPendingSteers((prev) => prev.filter((s) => s.sessionKey !== sk))
      ctx.midTurnInjectRef.current = ctx.midTurnInjectRef.current.filter((x) => x.sessionKey !== sk)

      void restorePendingInjects(sk)
        .then((res) => {
          const restored = Array.isArray(res?.restored) ? res.restored : []
          const restoredTexts = restored
            .map((item: { text?: string; messageId?: string }) => ({
              messageId: String(item?.messageId || '').trim(),
              text: String(item?.text || '').trim(),
            }))
            .filter((item) => item.text && !isTaskNotificationInject(item))
            .map((item) => item.text)
          const mergedParts = [...restoredTexts, ...queueTexts]
          if (!mergedParts.length) return
          if (String(ctx.sessionRef.current || '').trim() !== sk) return
          ctx.pushComposerText(
            mergeInterruptedComposerDraft(mergedParts, ctx.composerTextRef.current),
          )
          toast(`已恢复 ${mergedParts.length} 条到输入框`, 'info')
        })
        .catch(() => {
          if (!queueTexts.length) return
          if (String(ctx.sessionRef.current || '').trim() !== sk) return
          ctx.pushComposerText(
            mergeInterruptedComposerDraft(queueTexts, ctx.composerTextRef.current),
          )
        })
    },
    onBackgroundStopComplete: ({ sessionKey: sk, stopRunId }) => {
      const rt = getSessionRuntime(sk)
      if (stopRunId) rtAddStoppedRun(rt, stopRunId)
    },
    onRefreshSessions: () => void ctx.refreshSessionsRef.current?.(),
    onReloadHistory: () => void ctx.reloadHistoryFromDb({ dbOnly: true, bypassCache: true }),
    onScheduleRuntimeBump: () => ctx.scheduleBump({ immediate: true }),
    deleteLiveRunSnapshot: (sk) => ctx.deleteLiveRunSnapshotBestEffort(sk),
    onSessionRunEnded: (sk, opts) => {
      clearSessionExecutionStateForEnded(sk)
      ctx.setSessions((prev) =>
        patchSessionListRunEnded(
          prev,
          sk,
          opts ?? { terminalStatus: 'cancelled', reason: 'user_stop' },
        ),
      )
    },
    toast: (message, kind) => toast(message, kind),
  }
}
