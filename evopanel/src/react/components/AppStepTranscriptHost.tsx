import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchSubtaskConversationHistory } from '../../lib/subtask-conversation-history.js'
import type { CollabSubtaskSnapshot, SubtaskTranscriptModalPayload } from '../chat-types.js'
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
    const mid = String(request.mainTaskId || '').trim()
    const sid = String(request.subtaskId || '').trim()
    const lead = String(request.leadThreadId || '').trim()
    const title = String(request.title || sid).trim() || sid
    const status = String(request.status || 'pending').trim() || 'pending'
    let cancelled = false
    queueMicrotask(() => {
      setLoading(true)
      setPayload({
        subtaskId: sid,
        mainTaskId: mid,
        leadThreadId: lead,
        title,
        status,
        rows: [],
        emptyConversation: true,
      })
    })
    const snapshot = {
      subtaskId: sid,
      name: title,
      description: String(request.description || ''),
      status,
      assignedAgent: String(request.assignedAgent || ''),
      parentTaskId: mid,
      subtask_thread_id: String(request.subtaskThreadId || ''),
      subtaskThreadId: String(request.subtaskThreadId || ''),
    }
    void fetchSubtaskConversationHistory({
      mainTaskId: mid,
      subtaskId: sid,
      leadThreadId: lead,
      storedSubtaskThreadId: String(request.subtaskThreadId || ''),
      subtaskSnapshot: snapshot,
    })
      .then((resp) => {
        if (cancelled) return
        setPayload({
          subtaskId: sid,
          mainTaskId: mid,
          leadThreadId: lead,
          title,
          status,
          rows: resp.rows,
          emptyConversation: resp.emptyConversation,
          outcome: resp.outcome,
        })
      })
      .catch(() => {
        if (cancelled) return
        setPayload({
          subtaskId: sid,
          mainTaskId: mid,
          leadThreadId: lead,
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
    // only reopen when target ids change or refreshKey bumps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.mainTaskId, request?.subtaskId, request?.leadThreadId, request?.refreshKey])

  const handlePayloadChange = useCallback(
    (next: SubtaskTranscriptModalPayload | null) => {
      if (!next) onClose()
      else setPayload(next)
    },
    [onClose],
  )

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

  return (
    <>
      <SubtaskExecutionDrawer
        open
        mode={mode}
        portalTarget={portalTarget}
        subtaskId={payload.subtaskId}
        statusClass={transcript.statusClass}
        statusLabel={loading ? '加载中' : transcript.statusLabel}
        summaryAgent={readOnly ? '' : transcript.modalSummaryAgent}
        shortTitle={readOnly ? '执行记录' : transcript.modalShortTitle}
        rows={transcript.modalRowsForDisplay}
        streamActive={transcript.modalIsStreaming}
        sending={transcript.sending}
        canCompose={transcript.modalCanCompose}
        composeText={transcript.composeText}
        composeError={transcript.composeError}
        copyPlainText={transcript.modalCopyPlainText}
        showDetailButton={!readOnly}
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
