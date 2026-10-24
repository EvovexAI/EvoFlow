/**
 * 协作工作流节点 → V4 右侧独立进度 tab（每个 Agent/节点一张，互不覆盖）。
 * 与 collab-workflow 画布 tab 并存：先看图，再点节点看输出。
 *
 * 关联链路：
 *   节点 click → fetchSubtaskConversationHistory(mainTaskId, subtaskId)
 *     → GET /api/tasks/{mid}/subtasks/{sid}/conversation-history
 *     → evoflow_chat_messages（subtask_thread_id / SubThread_{sid} / {lead}__sub__{sid}）
 *   → 本函数把 rows/outcome 写入 tab.data（勿丢弃，否则侧栏会空）
 *   → V4CollabSubtaskTranscriptPane 种子渲染 + 轮询刷新
 */
import { rightStageStore } from './right-stage-store.js'

export type CollabSubtaskStageOutcome = {
  reported?: boolean
  status?: string
  task_report?: string
  summary?: string
  outcome_reported_at?: string | null
  evidence_paths?: string[]
  outputs?: Array<{
    type?: string
    key?: string
    value?: string
    label?: string
  }>
}

export type CollabSubtaskStagePayload = {
  subtaskId: string
  mainTaskId?: string
  leadThreadId?: string
  title?: string
  status?: string
  assignedAgent?: string
  description?: string
  subtaskThreadId?: string
  /** 节点点击时已预取的展示行，打开 tab 立刻可见 */
  rows?: unknown[]
  emptyConversation?: boolean
  initialText?: string
  outcome?: CollabSubtaskStageOutcome
}

export type OpenCollabSubtaskStageOpts = {
  sessionKey?: string | null
  /** 默认 wide：与子代理 transcript 同口径 */
  layout?: 'half' | 'wide' | 'narrow' | 'workspace-write'
}

export function collabSubtaskStageTabId(subtaskId: string): string {
  return `collabSubtaskTranscript:${String(subtaskId || '').trim()}`
}

/** 打开（或激活）某协作节点的进度 tab。 */
export function openCollabSubtaskInRightStage(
  payload: CollabSubtaskStagePayload,
  opts?: OpenCollabSubtaskStageOpts,
): string {
  const sid = String(payload?.subtaskId || '').trim()
  if (!sid) return ''
  const title = String(payload.title || sid).trim() || '节点进度'
  const id = collabSubtaskStageTabId(sid)
  const rows = Array.isArray(payload.rows) ? payload.rows : undefined
  rightStageStore.show({
    kind: 'collabSubtaskTranscript',
    id,
    title,
    layout: opts?.layout || 'wide',
    sessionKey: String(opts?.sessionKey || '').trim() || undefined,
    data: {
      subtaskId: sid,
      mainTaskId: String(payload.mainTaskId || '').trim(),
      leadThreadId: String(payload.leadThreadId || '').trim(),
      title,
      status: String(payload.status || '').trim(),
      assignedAgent: String(payload.assignedAgent || '').trim(),
      description: String(payload.description || '').trim(),
      subtaskThreadId: String(payload.subtaskThreadId || '').trim(),
      sessionKey: String(opts?.sessionKey || '').trim(),
      ...(rows ? { rows } : {}),
      ...(payload.emptyConversation != null ? { emptyConversation: !!payload.emptyConversation } : {}),
      ...(payload.initialText != null ? { initialText: String(payload.initialText || '') } : {}),
      ...(payload.outcome && typeof payload.outcome === 'object' ? { outcome: payload.outcome } : {}),
    },
  })
  return id
}
