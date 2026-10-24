/**
 * 协作工作流节点 → V4 右侧独立进度 tab（每个 Agent/节点一张，互不覆盖）。
 * 与 collab-workflow 画布 tab 并存：先看图，再点节点看输出。
 */
import { rightStageStore } from './right-stage-store.js'

export type CollabSubtaskStagePayload = {
  subtaskId: string
  mainTaskId?: string
  leadThreadId?: string
  title?: string
  status?: string
  assignedAgent?: string
  description?: string
  subtaskThreadId?: string
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
    },
  })
  return id
}
