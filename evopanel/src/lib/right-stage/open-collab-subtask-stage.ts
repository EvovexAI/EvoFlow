/**
 * 协作工作流节点 → V4 右侧独立进度 tab（每个 Agent/节点一张，互不覆盖）。
 * 与 collab-workflow 画布 tab 并存：先看图，再点节点看输出。
 *
 * 关联链路：
 *   节点 click → fetchSubtaskConversationHistory(mainTaskId, subtaskId, storedSubtaskThreadId?)
 *     → 优先 GET by-thread/{thread_id}/messages（与主聊同一表）
 *     → conversation-history 仅作 task/subtask → thread + outcome 解析
 *   → 本函数把 rows/outcome 写入 tab.data（勿丢弃，否则侧栏会空）
 *   → V4CollabSubtaskTranscriptPane 种子渲染 + 轮询刷新
 */
import { rightStageStore } from './right-stage-store.js'
import { isTaskCenterStageSessionKey } from './task-center-stage-key.js'

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

export function collabSubtaskStageTabId(subtaskId: string, sessionKey?: string | null): string {
  const sid = String(subtaskId || '').trim()
  if (!sid) return ''
  const base = `collabSubtaskTranscript:${sid}`
  return isTaskCenterStageSessionKey(sessionKey) ? `tc:${base}` : base
}

/** 打开（或激活）某协作节点的进度 tab。 */
export function openCollabSubtaskInRightStage(
  payload: CollabSubtaskStagePayload,
  opts?: OpenCollabSubtaskStageOpts,
): string {
  const sid = String(payload?.subtaskId || '').trim()
  if (!sid) return ''
  const sk = String(opts?.sessionKey || '').trim() || undefined
  const title = String(payload.title || sid).trim() || '节点进度'
  const id = collabSubtaskStageTabId(sid, sk)
  const rows = Array.isArray(payload.rows) ? payload.rows : undefined
  rightStageStore.show({
    kind: 'collabSubtaskTranscript',
    id,
    title,
    layout: opts?.layout || 'wide',
    sessionKey: sk,
    data: {
      subtaskId: sid,
      mainTaskId: String(payload.mainTaskId || '').trim(),
      leadThreadId: String(payload.leadThreadId || '').trim(),
      title,
      status: String(payload.status || '').trim(),
      assignedAgent: String(payload.assignedAgent || '').trim(),
      description: String(payload.description || '').trim(),
      subtaskThreadId: String(payload.subtaskThreadId || '').trim(),
      ...(rows ? { rows } : {}),
      ...(payload.emptyConversation != null ? { emptyConversation: !!payload.emptyConversation } : {}),
      ...(payload.initialText != null ? { initialText: String(payload.initialText || '') } : {}),
      ...(payload.outcome && typeof payload.outcome === 'object' ? { outcome: payload.outcome } : {}),
    },
  })
  return id
}
