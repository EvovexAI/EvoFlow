import { useCallback, useEffect, useMemo, useState } from 'react'
import { tasksAPI } from '../../lib/api-client.js'
import { fetchSubtaskConversationHistory } from '../../lib/subtask-conversation-history.js'
import { resolveAssignedAgentDisplayName } from '../../lib/tool-display.js'
import {
  buildSubtaskModalRowsForDisplay,
  isSubtaskRunning,
  resolveSubtaskCardDisplayStatus,
} from '../../lib/subtask-transcript-display.js'
import { isClaudeCodeSubagentType } from '../../lib/subagent-type-policy.js'
import { formatTaskStatusZh, taskStatusBadgeClass } from '../../lib/task-status-label.js'
import type {
  CollabSubtaskSnapshot,
  SubagentStreamTask,
  SubtaskTranscriptModalPayload,
} from '../chat-types.js'

export function useSubtaskTranscriptModal(options: {
  payload: SubtaskTranscriptModalPayload | null
  onPayloadChange: (next: SubtaskTranscriptModalPayload | null) => void
  modalSubtask: CollabSubtaskSnapshot | null
  modalStreamTask: SubagentStreamTask | null
  agents?: unknown[]
  mainTaskId?: string
  leadThreadId?: string
  /** 应用调试坞：只读执行记录，不开放续聊 */
  readOnly?: boolean
}) {
  const {
    payload,
    onPayloadChange,
    modalSubtask,
    modalStreamTask,
    agents,
    mainTaskId = '',
    leadThreadId = '',
    readOnly = false,
  } = options

  const [composeText, setComposeText] = useState('')
  const [sending, setSending] = useState(false)
  const [composeError, setComposeError] = useState('')
  const [detailOpen, setDetailOpen] = useState(false)

  useEffect(() => {
    queueMicrotask(() => {
        setComposeText('')
        setComposeError('')
        setSending(false)
        setDetailOpen(false)
      })
  }, [payload?.subtaskId])

  const modalMainTaskId = useMemo(() => {
    if (!payload) return ''
    return String(payload.mainTaskId || mainTaskId || '').trim()
  }, [payload, mainTaskId])

  const refreshHistory = useCallback(async () => {
    if (!payload || !modalMainTaskId) return
    const effectiveLeadThreadId = String(payload.leadThreadId || leadThreadId || '').trim()
    const resp = await fetchSubtaskConversationHistory({
      mainTaskId: modalMainTaskId,
      subtaskId: payload.subtaskId,
      leadThreadId: effectiveLeadThreadId,
      subtaskSnapshot: modalSubtask,
    })
    const msgArr = Array.isArray(resp?.messages) ? resp.messages : []
    const rows = Array.isArray(resp?.rows) ? resp.rows : []
    const outcome =
      resp?.outcome && typeof resp.outcome === 'object' ? resp.outcome : payload.outcome
    onPayloadChange({
      ...payload,
      mainTaskId: modalMainTaskId,
      leadThreadId: effectiveLeadThreadId || payload.leadThreadId,
      rows,
      emptyConversation: msgArr.length === 0,
      initialText: msgArr.length === 0 ? payload.initialText || '' : '',
      outcome,
    })
  }, [payload, modalMainTaskId, leadThreadId, modalSubtask, onPayloadChange])

  const modalStatus = useMemo(() => {
    if (!payload) return 'pending'
    if (modalSubtask) return resolveSubtaskCardDisplayStatus(modalSubtask.status, modalStreamTask || undefined)
    if (modalStreamTask) {
      if (modalStreamTask.phase === 'running') return 'executing'
      return modalStreamTask.phase
    }
    return payload.status || 'pending'
  }, [payload, modalSubtask, modalStreamTask])

  const modalStreamLiveText = useMemo(() => {
    if (!payload) return ''
    return String(modalStreamTask?.liveOutput || modalStreamTask?.progressHint || '').trim()
  }, [payload, modalStreamTask])

  const modalTools = useMemo(() => {
    if (!payload) return []
    if (Array.isArray(modalStreamTask?.tools) && modalStreamTask.tools.length > 0) return modalStreamTask.tools
    const observed = Array.isArray(modalSubtask?.observedToolCalls) ? modalSubtask!.observedToolCalls! : []
    return observed
  }, [payload, modalStreamTask, modalSubtask])

  const preferSubtaskStreamOverFetchedHistory = useMemo(() => {
    if (!modalStreamTask) return false
    if (!isClaudeCodeSubagentType(modalStreamTask.subagentType)) return false
    const hasFetchedRows = Array.isArray(payload?.rows) && payload.rows.length > 0
    if (hasFetchedRows && !sending) return false
    if (modalStreamTask.phase === 'running') return true
    const live = String(modalStreamTask.liveOutput || '').trim()
    const hint = String(modalStreamTask.progressHint || '').trim()
    return live.length > 0 || hint.length > 0
  }, [modalStreamTask, payload, sending])

  const transcriptSyntheticText = useMemo(() => {
    if (!payload) return ''
    if (preferSubtaskStreamOverFetchedHistory) return modalStreamLiveText
    if (payload.emptyConversation) return ''
    if (modalStreamLiveText && (modalStreamTask?.phase === 'running' || isSubtaskRunning(modalStatus))) {
      return modalStreamLiveText
    }
    return ''
  }, [
    payload,
    modalStreamLiveText,
    preferSubtaskStreamOverFetchedHistory,
    modalStreamTask?.phase,
    modalStatus,
  ])

  const modalRowsForDisplay = useMemo(
    () =>
      buildSubtaskModalRowsForDisplay({
        payload,
        transcriptSyntheticText,
        modalTools,
        preferSubtaskStreamOverFetchedHistory,
        modalStreamTask,
        modalStatus,
        modalSending: sending,
      }),
    [
      payload,
      transcriptSyntheticText,
      modalTools,
      preferSubtaskStreamOverFetchedHistory,
      modalStreamTask,
      modalStatus,
      sending,
    ],
  )

  const modalShortTitle = useMemo(() => {
    const name = String(modalSubtask?.name || '').trim()
    if (name) return name
    const t = String(payload?.title || '子任务对话').trim()
    const sep = t.indexOf(' · ')
    return sep > 0 ? t.slice(sep + 3).trim() : t
  }, [modalSubtask?.name, payload?.title])

  const modalSummaryAgent = useMemo(() => {
    const code = String(modalSubtask?.assignedAgent || '').trim()
    const fromSnap = String(modalSubtask?.assignedAgentDisplay || '').trim()
    if (fromSnap) return fromSnap
    if (code) return resolveAssignedAgentDisplayName(code, agents) || code
    const t = String(payload?.title || '').trim()
    const sep = t.indexOf(' · ')
    return sep > 0 ? t.slice(0, sep).trim() : ''
  }, [modalSubtask, payload?.title, agents])

  const modalCopyPlainText = useMemo(
    () =>
      modalRowsForDisplay
        .map((r: any) => String(r?.text || '').trim())
        .filter(Boolean)
        .join('\n\n'),
    [modalRowsForDisplay],
  )

  const modalCanCompose = !readOnly && !!payload && !!modalMainTaskId && !!payload.subtaskId
  const handleSend = useCallback(async () => {
    const text = composeText.trim()
    if (!text || !payload || !modalMainTaskId) return
    setSending(true)
    setComposeError('')
    try {
      await tasksAPI.continueSubtaskSession(modalMainTaskId, payload.subtaskId, text, {
        keepSessionOpen: true,
        waitForCompletion: true,
      })
      setComposeText('')
      await refreshHistory()
    } catch (e: any) {
      setComposeError(String(e?.message || e || '发送失败'))
    } finally {
      setSending(false)
    }
  }, [composeText, payload, modalMainTaskId, refreshHistory])

  const statusClass = taskStatusBadgeClass(modalStatus)
  const statusLabel = formatTaskStatusZh(modalStatus, { fallback: '待处理' })

  const modalIsStreaming = useMemo(() => {
    if (!payload) return false
    if (sending) return true
    if (modalStreamTask?.phase === 'running') return true
    return isSubtaskRunning(modalStatus)
  }, [payload, sending, modalStreamTask?.phase, modalStatus])

  return {
    modalMainTaskId,
    modalStatus,
    modalShortTitle,
    modalSummaryAgent,
    modalRowsForDisplay,
    modalIsStreaming,
    modalCopyPlainText,
    modalCanCompose,
    composeText,
    setComposeText,
    sending,
    composeError,
    detailOpen,
    setDetailOpen,
    handleSend,
    refreshHistory,
    statusClass,
    statusLabel,
  }
}
