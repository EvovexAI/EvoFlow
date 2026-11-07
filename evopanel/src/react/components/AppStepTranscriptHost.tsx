import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { fetchSubtaskTranscriptMeta } from '../../lib/subtask-conversation-history.js'
import type { CollabSubtaskSnapshot, SubtaskTranscriptModalPayload } from '../chat-types.js'
import { V4CollabSubtaskTranscriptPane } from '../chat-app/right-stage/v4-collab-subtask-transcript-pane.js'
import { useSubtaskTranscriptModal } from '../hooks/useSubtaskTranscriptModal.js'
import { SubtaskDetailModal } from './SubtaskDetailModal.js'
import { SubtaskExecutionDrawer } from './SubtaskExecutionDrawer.js'

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
  /**
   * 历史字段：调试坞已对齐员工/协作节点面板（可续聊）。
   * true 时仍显示对话，仅关闭「查看详情」弹层入口。
   */
  readOnly?: boolean
  /** 变化时重新拉取执行记录（轮询用） */
  refreshKey?: string | number
  /** 归属会话 key（工具详情 / 工作区） */
  sessionKey?: string
}

type Props = {
  request: AppStepTranscriptOpenRequest | null
  onClose: () => void
}

/**
 * 应用调试坞：直接复用协作节点进度面板（与员工对话同款 V4 + 齿轮 + 可续聊）。
 * 弹层 modal 路径仍走 SubtaskExecutionDrawer（任务中心等）。
 */
export function AppStepTranscriptHost({ request, onClose }: Props) {
  const [payload, setPayload] = useState<SubtaskTranscriptModalPayload | null>(null)
  const [loading, setLoading] = useState(false)

  const modalSubtask = useMemo((): CollabSubtaskSnapshot | null => {
    if (!request) return null
    return {
      subtaskId: request.subtaskId,
      name: request.title || '',
      description: request.description || '',
      status: request.status || 'pending',
      assignedAgent: request.assignedAgent || '',
      parentTaskId: request.mainTaskId,
      subtask_thread_id: request.subtaskThreadId || '',
      subtaskThreadId: request.subtaskThreadId || '',
    } as CollabSubtaskSnapshot
  }, [request])

  useEffect(() => {
    if (!request) {
      queueMicrotask(() => {
        setPayload(null)
        setLoading(false)
      })
      return
    }
    // drawer 路径交给 V4CollabSubtaskTranscriptPane 自己拉 meta / catchup
    if (request.mode === 'drawer' && request.portalTarget) {
      queueMicrotask(() => {
        setPayload({
          subtaskId: request.subtaskId,
          mainTaskId: request.mainTaskId,
          leadThreadId: request.leadThreadId,
          subtaskThreadId: request.subtaskThreadId,
          title: request.title || request.subtaskId,
          status: request.status || 'pending',
          rows: [],
          emptyConversation: !request.subtaskThreadId,
        })
        setLoading(false)
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

    queueMicrotask(() => {
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
    })

    void fetchSubtaskTranscriptMeta({
      mainTaskId: mid,
      subtaskId: sid,
      leadThreadId: lead,
      storedSubtaskThreadId: storedThread,
      subtaskSnapshot: {
        subtaskId: sid,
        name: title,
        description: String(request.description || ''),
        status,
        assignedAgent: String(request.assignedAgent || ''),
        parentTaskId: mid,
        subtask_thread_id: storedThread,
        subtaskThreadId: storedThread,
      },
    })
      .then((resp) => {
        if (cancelled) return
        const threadId = String(resp?.thread_id || storedThread || '').trim()
        setPayload({
          subtaskId: sid,
          mainTaskId: mid,
          leadThreadId: lead,
          subtaskThreadId: threadId || undefined,
          title,
          status: String(resp?.status || status).trim() || status,
          rows: [],
          emptyConversation: !threadId,
          outcome: resp.outcome,
        })
      })
      .catch(() => {
        if (cancelled || storedThread) return
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
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.mainTaskId, request?.subtaskId, request?.leadThreadId, request?.subtaskThreadId, request?.refreshKey, request?.mode, request?.portalTarget])

  const handlePayloadChange = useCallback(
    (next: SubtaskTranscriptModalPayload | null) => {
      if (!next) onClose()
      else setPayload(next)
    },
    [onClose],
  )

  const transcript = useSubtaskTranscriptModal({
    payload: request?.mode === 'drawer' && request?.portalTarget ? null : payload,
    onPayloadChange: handlePayloadChange,
    modalSubtask,
    modalStreamTask: null,
    agents: [],
    mainTaskId: request?.mainTaskId || '',
    leadThreadId: request?.leadThreadId || '',
    readOnly: !!request?.readOnly,
  })

  if (!request) return null

  // 调试坞：与右栏「节点进度 / 员工对话」同款面板
  if (request.mode === 'drawer' && request.portalTarget) {
    return createPortal(
      <V4CollabSubtaskTranscriptPane
        mainTaskId={request.mainTaskId}
        subtaskId={request.subtaskId}
        leadThreadId={request.leadThreadId}
        title={request.title}
        status={request.status}
        assignedAgent={request.assignedAgent}
        description={request.description}
        subtaskThreadId={request.subtaskThreadId}
        sessionKey={request.sessionKey}
        embedded
        allowCompose
        onClose={onClose}
      />,
      request.portalTarget,
    )
  }

  if (!payload) return null

  const knownThread =
    transcript.v4SessionId || request?.subtaskThreadId || payload.subtaskThreadId || ''

  return (
    <>
      <SubtaskExecutionDrawer
        open
        mode="modal"
        subtaskId={payload.subtaskId}
        v4SessionId={String(knownThread)}
        statusClass={transcript.statusClass}
        statusLabel={loading && !knownThread ? '加载中' : transcript.statusLabel}
        summaryAgent={transcript.modalSummaryAgent}
        shortTitle={transcript.modalShortTitle}
        rows={knownThread ? [] : transcript.modalRowsForDisplay}
        streamActive={transcript.modalIsStreaming}
        sending={transcript.sending}
        canCompose={transcript.modalCanCompose}
        composeText={transcript.composeText}
        composeError={transcript.composeError}
        copyPlainText={transcript.modalCopyPlainText}
        showDetailButton={!request.readOnly}
        onClose={onClose}
        onOpenDetail={request.readOnly ? undefined : () => transcript.setDetailOpen(true)}
        onComposeTextChange={transcript.setComposeText}
        onSend={() => void transcript.handleSend()}
      />
      {!request.readOnly ? (
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
