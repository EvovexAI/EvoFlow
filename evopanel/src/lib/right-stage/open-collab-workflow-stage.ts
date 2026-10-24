/**
 * 协作工作流图 → 右栏 tab（对话 workspace 或任务中心 task-center:*）。
 */
import { rightStageStore } from './right-stage-store.js'
import { isTaskCenterStageSessionKey } from './task-center-stage-key.js'

export type CollabWorkflowStagePayload = {
  mainTaskId: string
  leadThreadId?: string
  title?: string
}

export type OpenCollabWorkflowStageOpts = {
  sessionKey?: string | null
  layout?: 'half' | 'wide' | 'narrow' | 'workspace-write'
}

export function collabWorkflowStageTabId(mainTaskId: string, sessionKey?: string | null): string {
  const tid = String(mainTaskId || '').trim()
  if (!tid) return ''
  const base = `workflow:${tid}`
  return isTaskCenterStageSessionKey(sessionKey) ? `tc:${base}` : base
}

/** 打开（或激活）工作流图画布 tab。 */
export function openCollabWorkflowInRightStage(
  payload: CollabWorkflowStagePayload,
  opts?: OpenCollabWorkflowStageOpts,
): string {
  const mid = String(payload?.mainTaskId || '').trim()
  if (!mid) return ''
  const sk = String(opts?.sessionKey || '').trim() || undefined
  const id = collabWorkflowStageTabId(mid, sk)
  const title = String(payload.title || '工作流').trim() || '工作流'
  rightStageStore.show({
    kind: 'collab-workflow',
    id,
    title,
    layout: opts?.layout || 'half',
    sessionKey: sk,
    data: {
      mainTaskId: mid,
      leadThreadId: String(payload.leadThreadId || '').trim(),
    },
  })
  return id
}
