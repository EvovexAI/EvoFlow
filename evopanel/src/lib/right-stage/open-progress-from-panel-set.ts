/**
 * 把 panel_set / 平台 CTA 的 progress surface 落到右栏（与任务中心打开同构）。
 * 会话级：应传入触发会话的 sessionKey；缺省时由 store 冻结当前 UI 会话归属。
 */
import { normalizeRightStageKind } from './right-stage-types.js'
import { openCollabWorkflowInRightStage } from './open-collab-workflow-stage.js'
import { openCollabSubtaskInRightStage } from './open-collab-subtask-stage.js'
import { openEmployeeProcessInRightStage } from './open-employee-process-stage.js'
import { openShellPageInRightStage } from './open-shell-page-stage.js'
import { logRightStage } from './panel-set-debug-log.js'
import { rightStageStore } from './right-stage-store.js'

export type ProgressStageSurface = {
  kind?: string
  id?: string
  title?: string
  layout?: string
  data?: Record<string, unknown> | null
  sessionKey?: string | null
}

function firstStr(...vals: unknown[]): string {
  for (const v of vals) {
    const s = String(v ?? '').trim()
    if (s) return s
  }
  return ''
}

/**
 * @returns 打开的 tab id；无法识别则空串
 */
export function openProgressFromPanelSet(
  surface: ProgressStageSurface | null | undefined,
  opts?: { sessionKey?: string | null },
): string {
  if (!surface || typeof surface !== 'object') {
    logRightStage('openProgress:skip empty surface')
    return ''
  }
  const kind = normalizeRightStageKind(String(surface.kind || ''))
  const data = surface.data && typeof surface.data === 'object' ? surface.data : {}
  const title = firstStr(surface.title, data.title)
  const sk = firstStr(opts?.sessionKey, surface.sessionKey) || undefined

  if (kind === 'collab-workflow') {
    const mainTaskId = firstStr(data.mainTaskId, data.main_task_id, data.taskId, data.task_id)
    if (!mainTaskId) {
      logRightStage('openProgress:collab-workflow missing mainTaskId', { dataKeys: Object.keys(data) })
      return ''
    }
    const tabId = openCollabWorkflowInRightStage(
      {
        mainTaskId,
        leadThreadId: firstStr(data.leadThreadId, data.lead_thread_id, data.threadId, data.thread_id),
        title: title || '工作流',
      },
      { sessionKey: sk, layout: (surface.layout as 'half') || 'half' },
    )
    logRightStage('openProgress:collab-workflow', { tabId, mainTaskId, title }, { store: rightStageStore })
    return tabId
  }

  if (kind === 'collabSubtaskTranscript') {
    const subtaskId = firstStr(data.subtaskId, data.subtask_id)
    const mainTaskId = firstStr(data.mainTaskId, data.main_task_id, data.taskId, data.task_id)
    if (!subtaskId) return ''
    return openCollabSubtaskInRightStage(
      {
        subtaskId,
        mainTaskId,
        leadThreadId: firstStr(data.leadThreadId, data.lead_thread_id, data.threadId, data.thread_id),
        title: title || undefined,
        status: firstStr(data.status),
        assignedAgent: firstStr(data.assignedAgent, data.assigned_to),
        description: firstStr(data.description),
        subtaskThreadId: firstStr(data.subtaskThreadId, data.subtask_thread_id),
        outcome:
          data.outcome && typeof data.outcome === 'object'
            ? (data.outcome as import('./open-collab-subtask-stage.js').CollabSubtaskStageOutcome)
            : undefined,
      },
      { sessionKey: sk, layout: (surface.layout as 'wide') || 'wide' },
    )
  }

  if (kind === 'employeeProcess') {
    const taskId = firstStr(
      data.taskId,
      data.task_id,
      data.mainTaskId,
      data.main_task_id,
      data.related_task_id,
      data.relatedTaskId,
    )
    const agentCode = firstStr(data.agentCode, data.agent_code, data.assigned_to)
    // 派发/唤醒常只有 agent：仍开右栏实时进度（对话面板）
    if (!agentCode) return ''
    return openEmployeeProcessInRightStage(
      {
        taskId: taskId || '',
        agentCode,
        roleName: firstStr(data.roleName, data.role_name),
        title: title || undefined,
        roundId: firstStr(data.roundId, data.round_id, data.source_ref),
        busy: data.busy !== false,
        employeeSessionKey: firstStr(data.sessionKey, data.session_key, data.employeeSessionKey),
      },
      { sessionKey: sk, layout: (surface.layout as 'wide') || 'wide' },
    )
  }

  if (kind === 'shell-page') {
    const path = firstStr(data.path, data.route, data.href, data.url)
    if (!path) {
      logRightStage('openProgress:shell-page missing path', { dataKeys: Object.keys(data) })
      return ''
    }
    const entityLabel = firstStr(
      data.entityLabel,
      data.entity_label,
      data.roleName,
      data.role_name,
      data.name,
      data.title,
    )
    const tabId = openShellPageInRightStage(
      {
        path,
        title: title || entityLabel || undefined,
        entityLabel: entityLabel || undefined,
        mountId: firstStr(data.mountId, data.mount_id),
        layout: (surface.layout as 'wide') || 'wide',
      },
      { sessionKey: sk, layout: (surface.layout as 'wide') || 'wide' },
    )
    logRightStage('openProgress:shell-page', { tabId, path, title: title || entityLabel }, {
      store: rightStageStore,
    })
    return tabId
  }

  return ''
}

export function isProgressStageKind(kind: string | null | undefined): boolean {
  const k = normalizeRightStageKind(kind)
  return (
    k === 'collab-workflow' ||
    k === 'collabSubtaskTranscript' ||
    k === 'employeeProcess' ||
    k === 'shell-page'
  )
}
