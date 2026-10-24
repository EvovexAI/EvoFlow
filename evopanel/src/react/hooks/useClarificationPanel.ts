/**
 * Clarification dock: schedule authoritative resolve + stream-turn detection.
 * Extracted from ChatApp.tsx (P2) — pure helpers live in chat-app/thread-panel/*.
 */
import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { formatActivityDetailFromRunningToolCalls } from '../../lib/tool-display.js'
import { getActivityHint } from '../lib/activity-hints.js'
import {
  clearClarificationLatch,
  latchClarificationToolCall,
  peekClarificationLatch,
  resolveClarificationPanelAuthoritative,
} from '../lib/clarify-tool-fetch.js'
import {
  isClarificationPreviewRenderable,
  isStaleClarificationPreview,
} from '../lib/clarify-chat-display.js'
import {
  findAskClarificationAwaitingUserInRows,
  readAskClarificationInput,
} from '../../lib/clarify-preview-resolve.js'
import { isPlanExecutionConfirmationClarification } from '../../lib/plan-exec-ui.js'
import { streamTurnHasVisibleContent } from '../lib/stream-turn-engine.js'
import { getSessionRuntime, type SessionRuntime } from '../lib/session-runtime-store.js'
import { turnBusyForSession } from '../chat-app/utils/session-busy.js'
import {
  clearThreadPanelClarification,
  extractLatestClarificationFromRows,
  parseClarificationFromTool,
  rowsAwaitUserReplyAfterSend,
  shouldSuppressClarificationPanel,
} from '../chat-app/thread-panel/clarification.js'
import type { DisplayRow, StreamState, ThreadPanelState } from '../chat-types.js'

export type CommitThreadPanelForSession = (
  sessionKey: string,
  updater: (prev: ThreadPanelState) => ThreadPanelState,
) => void

export type ClarificationPanelResolveOpts = {
  toolCallId?: string
  localTool?: unknown
  preferToolRetries?: boolean
}

export function useClarificationPanel(opts: {
  selectedSessionKey: string
  sessionRef: MutableRefObject<string>
  rowsRef: MutableRefObject<DisplayRow[]>
  commitThreadPanelForSessionRef: MutableRefObject<CommitThreadPanelForSession>
  setThreadPanelState: Dispatch<SetStateAction<ThreadPanelState>>
  /** Prefer ref so submit can be declared before handleSend body. */
  handleSendRef: MutableRefObject<(...args: any[]) => any>
  /** Goal-mode capture; may be filled after hook mount. */
  onClarificationSubmittedRef: MutableRefObject<
    ((answerText: string) => void | Promise<void>) | undefined | null
  >
}) {
  const {
    selectedSessionKey,
    sessionRef,
    rowsRef,
    commitThreadPanelForSessionRef,
    setThreadPanelState,
    handleSendRef,
    onClarificationSubmittedRef,
  } = opts

  const clarifyResolveSeqRef = useRef<Map<string, number>>(new Map())

  const bumpClarifyResolveSeq = useCallback((sessionKey: string) => {
    const sk = String(sessionKey || '').trim()
    if (!sk) return
    clarifyResolveSeqRef.current.set(sk, (clarifyResolveSeqRef.current.get(sk) || 0) + 1)
  }, [])

  const scheduleClarificationPanelResolve = useCallback(
    (sessionKey: string, resolveOpts?: ClarificationPanelResolveOpts) => {
      const sk = String(sessionKey || '').trim()
      if (!sk) return
      const liveRows = rowsRef.current || []
      if (
        turnBusyForSession(sessionRef.current) &&
        rowsAwaitUserReplyAfterSend(liveRows) &&
        !findAskClarificationAwaitingUserInRows(liveRows)
      ) {
        return
      }
      const tcid = String(resolveOpts?.toolCallId || peekClarificationLatch(sk) || '').trim()
      if (tcid) latchClarificationToolCall(sk, tcid)
      const gen = (clarifyResolveSeqRef.current.get(sk) || 0) + 1
      clarifyResolveSeqRef.current.set(sk, gen)
      void resolveClarificationPanelAuthoritative(sk, {
        toolCallId: tcid || undefined,
        localTool: resolveOpts?.localTool,
        preferToolRetries: resolveOpts?.preferToolRetries,
      }).then((hit) => {
        if (clarifyResolveSeqRef.current.get(sk) !== gen) return
        const activeSk = String(sessionRef.current || selectedSessionKey || '').trim()
        const rowsNow =
          sk === activeSk ? rowsRef.current || [] : getSessionRuntime(sk).rows || []
        const stillAwaiting = findAskClarificationAwaitingUserInRows(rowsNow)
        if (
          turnBusyForSession(sk) &&
          rowsAwaitUserReplyAfterSend(rowsNow) &&
          !stillAwaiting
        ) {
          commitThreadPanelForSessionRef.current(sk, (prev) => clearThreadPanelClarification(prev))
          return
        }
        if (!hit?.preview || !isClarificationPreviewRenderable(hit.preview)) {
          if (!stillAwaiting && !(resolveOpts?.preferToolRetries && tcid)) {
            commitThreadPanelForSessionRef.current(sk, (prev) => {
              if (shouldSuppressClarificationPanel(rowsNow, prev)) return prev
              return clearThreadPanelClarification(prev)
            })
          }
          return
        }
        const input = resolveOpts?.localTool ? readAskClarificationInput(resolveOpts.localTool) : null
        if (isPlanExecutionConfirmationClarification(hit.preview, input)) {
          commitThreadPanelForSessionRef.current(sk, (prev) => clearThreadPanelClarification(prev))
          return
        }
        commitThreadPanelForSessionRef.current(sk, (prev) => {
          if (shouldSuppressClarificationPanel(rowsNow, prev)) return prev
          return {
            ...prev,
            clarification: hit,
            activityKind: 'clarification',
            activityDetail: getActivityHint('clarification') || '等你选择呢~',
          }
        })
      })
    },
    [selectedSessionKey, sessionRef, rowsRef, commitThreadPanelForSessionRef],
  )
  const scheduleClarificationPanelResolveRef = useRef(scheduleClarificationPanelResolve)
  scheduleClarificationPanelResolveRef.current = scheduleClarificationPanelResolve

  /**
   * Shared clarification detection bridge — extracts ask_clarification from
   * the current stream turn's tool entries, schedules the authoritative API
   * resolve, and updates threadPanelState.clarification.
   */
  const detectAndScheduleClarificationFromStreamTurn = useCallback(
    (S: StreamState, rt: SessionRuntime, targetSk: string, _isBackground: boolean) => {
      const rowsForClarify: DisplayRow[] = [...rt.rows]
      if (streamTurnHasVisibleContent(S.turn)) {
        rowsForClarify.push({
          role: 'assistant',
          text: '',
          tools: S.turn.tools as DisplayRow['tools'],
          timestamp: Date.now(),
        })
      }
      const clarifyHit = extractLatestClarificationFromRows(rowsForClarify)
      const awaitingAsk = findAskClarificationAwaitingUserInRows(rowsForClarify)
      const clarifySk = String(targetSk || selectedSessionKey || '').trim()
      const awaitingToolCallId = awaitingAsk?.tool
        ? String(
            (awaitingAsk.tool as { id?: string; tool_call_id?: string }).id ||
              (awaitingAsk.tool as { tool_call_id?: string }).tool_call_id ||
              '',
          ).trim()
        : ''
      if (awaitingToolCallId && clarifySk) {
        scheduleClarificationPanelResolveRef.current(clarifySk, {
          toolCallId: awaitingToolCallId,
          localTool: awaitingAsk?.tool,
          preferToolRetries: true,
        })
      }
      const toolPreview = formatActivityDetailFromRunningToolCalls(S.turn.tools as unknown[])
      commitThreadPanelForSessionRef.current(clarifySk, (prev) => {
        let nextClarification = clarifyHit
        if (!nextClarification?.preview && awaitingAsk) {
          nextClarification =
            parseClarificationFromTool(awaitingAsk.tool) ?? prev.clarification ?? nextClarification
        }
        if (!nextClarification) {
          nextClarification = prev.clarification
        }
        const showClarify = !!(
          nextClarification?.preview &&
          (isClarificationPreviewRenderable(nextClarification.preview) ||
            isStaleClarificationPreview(nextClarification.preview))
        )
        const nextActivityKind = showClarify
          ? 'clarification'
          : toolPreview
            ? 'tools'
            : prev.activityKind === 'tools'
              ? 'thinking'
              : prev.activityKind
        const nextActivityDetail = showClarify
          ? getActivityHint('clarification') || '等你选择呢~'
          : toolPreview || (prev.activityKind === 'tools' ? getActivityHint('tools') : prev.activityDetail)
        if (
          nextClarification === prev.clarification &&
          nextActivityKind === prev.activityKind &&
          nextActivityDetail === prev.activityDetail
        ) {
          return prev
        }
        return {
          ...prev,
          clarification: nextClarification,
          activityKind: nextActivityKind,
          activityDetail: nextActivityDetail,
        }
      })
    },
    [selectedSessionKey, commitThreadPanelForSessionRef],
  )
  const detectAndScheduleClarificationRef = useRef(detectAndScheduleClarificationFromStreamTurn)
  detectAndScheduleClarificationRef.current = detectAndScheduleClarificationFromStreamTurn

  const handleSubmitClarification = useCallback(
    (answerText: string) => {
      clearClarificationLatch(selectedSessionKey)
      setThreadPanelState((prev) => ({ ...prev, clarification: null }))
      void onClarificationSubmittedRef.current?.(answerText)
      void handleSendRef.current(answerText)
    },
    [selectedSessionKey, setThreadPanelState, handleSendRef, onClarificationSubmittedRef],
  )

  return {
    clarifyResolveSeqRef,
    bumpClarifyResolveSeq,
    scheduleClarificationPanelResolve,
    scheduleClarificationPanelResolveRef,
    detectAndScheduleClarificationFromStreamTurn,
    detectAndScheduleClarificationRef,
    handleSubmitClarification,
  }
}
