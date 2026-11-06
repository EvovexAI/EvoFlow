import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchSubtaskTranscriptMeta } from '../../lib/subtask-conversation-history.js'
import {
  isSubtaskRunning,
  isTerminalSubtaskStatus,
} from '../../lib/subtask-transcript-display.js'
import {
  isTaskCancellableStatus,
  isTaskPlanningStatus,
} from '../../lib/task-status-label.js'
import type { CollabSubtaskSnapshot, SubtaskTranscriptModalPayload } from '../chat-types.js'
import { useSubtaskTranscriptModal } from '../hooks/useSubtaskTranscriptModal.js'
import { refreshEvoflowV4Session } from '../v4/V4StreamRowsBridge.js'
import { SubtaskDetailModal } from './SubtaskDetailModal.js'
import { SubtaskExecutionDrawer } from './SubtaskExecutionDrawer.js'

/** 本机通常无子会话 SSE：与协作节点进度同频拉 meta + V4 catchup */
const POLL_MS = 2000
const V4_SOFT_MS = POLL_MS
/** 刚结束再收一帧，避免末次工具停在旧投影 */
const SETTLE_DELAY_MS = 2500

export type AppStepTranscriptOpenRequest = {
  mainTaskId: string
  subtaskId: string
  /** workflow 纯应用运行可能为空，会话按 SubThread_{subtaskId} 定位 */
  leadThreadId?: string
  title?: string
  status?: string
  /** optional collab snapshot fields */
  assignedAgent?: string
  description?: string
  subtaskThreadId?: string
  /** 默认 modal；调试坞内嵌用 drawer + portalTarget */
  mode?: 'modal' | 'drawer'
  portalTarget?: HTMLElement | null
  /** 只读执行记录（正文 / 工具交错），不显示续聊输入框 */
  readOnly?: boolean
  /** 变化时重新拉取执行记录（轮询用） */
  refreshKey?: string | number
}

type Props = {
  request: AppStepTranscriptOpenRequest | null
  onClose: () => void
}

/**
 * 应用编辑器内复用协作工作流「节点对话」弹窗（同 SubtaskExecutionDrawer）。
 * 只读旁观：执行中持续 meta + V4 catchup；结束后再 settle 一次；可手动刷新。
 */
export function AppStepTranscriptHost({ request, onClose }: Props) {
  const [payload, setPayload] = useState<SubtaskTranscriptModalPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const wasRunningRef = useRef(false)
  const settledRef = useRef(false)

  const modalSubtask = useMemo((): CollabSubtaskSnapshot | null => {
    if (!request) return null
    return {
      subtaskId: request.subtaskId,
      name: request.title || '',
      description: request.description || '',
      status: request.status || payload?.status || 'pending',
      assignedAgent: request.assignedAgent || '',
      parentTaskId: request.mainTaskId,
      subtask_thread_id: request.subtaskThreadId || payload?.subtaskThreadId || '',
      subtaskThreadId: request.subtaskThreadId || payload?.subtaskThreadId || '',
    } as CollabSubtaskSnapshot
  }, [request, payload?.status, payload?.subtaskThreadId])

  const bumpV4 = useCallback((threadId: string) => {
    const tid = String(threadId || '').trim()
    if (!tid) return
    refreshEvoflowV4Session(tid, { softIntervalMs: V4_SOFT_MS })
  }, [])

  const pullMeta = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!request) return
      const mid = String(request.mainTaskId || '').trim()
      const sid = String(request.subtaskId || '').trim()
      if (!mid || !sid) return
      const lead = String(request.leadThreadId || '').trim()
      const storedThread = String(
        request.subtaskThreadId || payload?.subtaskThreadId || '',
      ).trim()
      const title = String(request.title || sid).trim() || sid
      const statusHint = String(request.status || payload?.status || 'pending').trim() || 'pending'
      if (!opts?.silent) setRefreshing(true)
      try {
        const resp = await fetchSubtaskTranscriptMeta({
          mainTaskId: mid,
          subtaskId: sid,
          leadThreadId: lead,
          storedSubtaskThreadId: storedThread,
          subtaskSnapshot: {
            subtaskId: sid,
            name: title,
            description: String(request.description || ''),
            status: statusHint,
            assignedAgent: String(request.assignedAgent || ''),
            parentTaskId: mid,
            subtask_thread_id: storedThread,
            subtaskThreadId: storedThread,
          },
        })
        const threadId = String(resp?.thread_id || storedThread || '').trim()
        const nextStatus = String(resp?.status || statusHint).trim() || statusHint
        setPayload((prev) => ({
          subtaskId: sid,
          mainTaskId: mid,
          leadThreadId: lead,
          subtaskThreadId: threadId || undefined,
          title,
          status: nextStatus,
          rows: prev?.rows || [],
          emptyConversation: !threadId,
          outcome: resp?.outcome ?? prev?.outcome,
        }))
        if (threadId) bumpV4(threadId)
      } finally {
        setLoading(false)
        if (!opts?.silent) setRefreshing(false)
      }
    },
    [request, payload?.subtaskThreadId, payload?.status, bumpV4],
  )

  useEffect(() => {
    if (!request) {
      queueMicrotask(() => {
        setPayload(null)
        setLoading(false)
        setRefreshing(false)
        wasRunningRef.current = false
        settledRef.current = false
      })
      return
    }
    const mid = String(request.mainTaskId || '').trim()
    const sid = String(request.subtaskId || '').trim()
    const lead = String(request.leadThreadId || '').trim()
    const storedThread = String(request.subtaskThreadId || '').trim()
    const title = String(request.title || sid).trim() || sid
    const status = String(request.status || 'pending').trim() || 'pending'
    let cancelled = false

    wasRunningRef.current = false
    settledRef.current = false

    // 已有 executor thread：立刻挂 V4，不再等 conversation-history（旧路径会先卡「加载中」）。
    queueMicrotask(() => {
      if (cancelled) return
      setPayload({
        subtaskId: sid,
        mainTaskId: mid,
        leadThreadId: lead,
        subtaskThreadId: storedThread || undefined,
        title,
        status,
        rows: [],
        emptyConversation: !storedThread,
      })
      setLoading(!storedThread)
      if (storedThread) bumpV4(storedThread)
    })

    void pullMeta({ silent: true }).catch(() => {
      if (cancelled) return
      if (storedThread) return
      setPayload({
        subtaskId: sid,
        mainTaskId: mid,
        leadThreadId: lead,
        subtaskThreadId: undefined,
        title,
        status,
        rows: [],
        emptyConversation: true,
      })
      setLoading(false)
    })

    return () => {
      cancelled = true
    }
    // only reopen when target ids change or refreshKey bumps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.mainTaskId, request?.subtaskId, request?.leadThreadId, request?.subtaskThreadId, request?.refreshKey])

  // request.status 随调试坞轮询更新时同步进 payload（不必等 refreshKey 全量重开）
  useEffect(() => {
    const next = String(request?.status || '').trim()
    if (!next || !payload) return
    if (String(payload.status || '') === next) return
    setPayload((prev) => (prev ? { ...prev, status: next } : prev))
  }, [request?.status, payload])

  const liveStatus = String(payload?.status || request?.status || 'pending')
  const running =
    isSubtaskRunning(liveStatus) ||
    isTaskPlanningStatus(liveStatus) ||
    (!isTerminalSubtaskStatus(liveStatus) && isTaskCancellableStatus(liveStatus) && loading)
  const keepPoll =
    !!request &&
    (!payload?.subtaskThreadId ||
      isSubtaskRunning(liveStatus) ||
      isTaskPlanningStatus(liveStatus) ||
      isTaskCancellableStatus(liveStatus))

  // 执行中 / 尚无 thread：持续 meta + V4 catchup（与员工过程 / 协作节点同策略）
  useEffect(() => {
    if (!request || !keepPoll) return
    let disposed = false
    wasRunningRef.current = wasRunningRef.current || running
    if (running) settledRef.current = false
    const tick = () => {
      if (disposed) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void pullMeta({ silent: true })
    }
    const timer = window.setInterval(tick, POLL_MS)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [request, keepPoll, running, pullMeta])

  // 刚结束：再收一帧投影
  useEffect(() => {
    if (!request || keepPoll || running) return
    if (!wasRunningRef.current || settledRef.current) return
    settledRef.current = true
    const tid = String(payload?.subtaskThreadId || request.subtaskThreadId || '').trim()
    if (tid) bumpV4(tid)
    const timer = window.setTimeout(() => {
      void pullMeta({ silent: true })
    }, SETTLE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [request, keepPoll, running, payload?.subtaskThreadId, bumpV4, pullMeta])

  const handlePayloadChange = useCallback(
    (next: SubtaskTranscriptModalPayload | null) => {
      if (!next) onClose()
      else setPayload(next)
    },
    [onClose],
  )

  const handleRefresh = useCallback(() => {
    const tid = String(payload?.subtaskThreadId || request?.subtaskThreadId || '').trim()
    if (tid) bumpV4(tid)
    void pullMeta()
  }, [payload?.subtaskThreadId, request?.subtaskThreadId, bumpV4, pullMeta])

  const transcript = useSubtaskTranscriptModal({
    payload,
    onPayloadChange: handlePayloadChange,
    modalSubtask,
    modalStreamTask: null,
    agents: [],
    mainTaskId: request?.mainTaskId || '',
    leadThreadId: request?.leadThreadId || '',
    readOnly: !!request?.readOnly,
  })

  if (!request || !payload) return null

  const mode = request.mode === 'drawer' ? 'drawer' : 'modal'
  const portalTarget = mode === 'drawer' ? request.portalTarget || null : null
  const readOnly = !!request.readOnly
  const knownThread =
    transcript.v4SessionId || request?.subtaskThreadId || payload.subtaskThreadId || ''

  return (
    <>
      <SubtaskExecutionDrawer
        open
        mode={mode}
        portalTarget={portalTarget}
        subtaskId={payload.subtaskId}
        v4SessionId={String(knownThread)}
        statusClass={transcript.statusClass}
        statusLabel={loading && !knownThread ? '加载中' : transcript.statusLabel}
        summaryAgent={readOnly ? '' : transcript.modalSummaryAgent}
        shortTitle={readOnly ? '执行记录' : transcript.modalShortTitle}
        rows={knownThread ? [] : transcript.modalRowsForDisplay}
        streamActive={transcript.modalIsStreaming}
        sending={transcript.sending}
        canCompose={transcript.modalCanCompose}
        composeText={transcript.composeText}
        composeError={transcript.composeError}
        copyPlainText={transcript.modalCopyPlainText}
        showDetailButton={!readOnly}
        refreshing={refreshing}
        onRefresh={handleRefresh}
        onClose={onClose}
        onOpenDetail={readOnly ? undefined : () => transcript.setDetailOpen(true)}
        onComposeTextChange={transcript.setComposeText}
        onSend={() => void transcript.handleSend()}
      />
      {!readOnly ? (
        <SubtaskDetailModal
          open={transcript.detailOpen}
          title={transcript.modalShortTitle}
          subtask={modalSubtask}
          outcome={payload.outcome}
          onClose={() => transcript.setDetailOpen(false)}
        />
      ) : null}
    </>
  )
}
