/**
 * 协作工作流节点 → V4 右侧独立进度 tab（每个 Agent/节点一张，互不覆盖）。
 * 与 collab-workflow 画布 tab 并存：先看图，再点节点看输出。
 *
 * 关联链路：
 *   节点 click → 解析 subtaskThreadId / outcome，写入 tab.data
 *   → V4CollabSubtaskTranscriptPane：对话体 = V4SessionPaneBridge
 *     （与主聊同一套 V4ZCodeTimeline）；底部 aside 用「结案摘要 / 产出路径」双 tab
 *   旧 modal-rows / SubtaskModalMessageRow 已退役，不再预取 rows。
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
      ...(payload.outcome && typeof payload.outcome === 'object' ? { outcome: payload.outcome } : {}),
    },
  })
  return id
}
