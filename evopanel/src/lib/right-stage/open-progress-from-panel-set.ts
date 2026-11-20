/**
 * 把 panel_set / 平台 CTA 的 progress surface 落到右栏（与任务中心打开同构）。
 * 会话级：应传入触发会话的 sessionKey；缺省时由 store 冻结当前 UI 会话归属。
 */
import {
  isProactiveSessionKey,
  parseProactiveSessionKey,
} from '../../react/lib/session-list/workspace-groups.js'
import { normalizeRightStageKind } from './right-stage-types.js'
import { describeMissingFields, missingContractFields } from './right-panel-contract.js'
import { openCollabWorkflowInRightStage } from './open-collab-workflow-stage.js'
import { openCollabSubtaskInRightStage } from './open-collab-subtask-stage.js'
import { openEmployeeProcessInRightStage } from './open-employee-process-stage.js'
import { openShellPageInRightStage } from './open-shell-page-stage.js'
import { logRightStage } from './panel-set-debug-log.js'
import { rightStageStore } from './right-stage-store.js'

/** 仅本岗 proactive key 可作员工对话；主聊 agent:main:* 等一律丢掉，防右栏串流。 */
function employeeOwnedSessionKey(sessionKey: string, agentCode: string): string {
  const sk = String(sessionKey || '').trim()
  const code = String(agentCode || '').trim()
  if (!sk || !code || !isProactiveSessionKey(sk)) return ''
  const parsed = parseProactiveSessionKey(sk)
  return String(parsed.agentCode || '').trim() === code ? sk : ''
}

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
 * 【self-evolution-bot · 2026-11-20 · 第87轮 · 模型:deepseek-v4.1-flash-1017】
 * 改了什么：缺必填字段时给用户一句可读提示，而不是静默不开。
 * 为什么：用户会点「查看进度」却什么也不发生，只能猜是坏了。用后端同一份
 * 契约描述到底缺什么，直接告诉用户/开发者。
 */
function notifyMissingFields(kind: string, data: Record<string, unknown>): void {
  const missing = missingContractFields(kind, data)
  const text = describeMissingFields(kind, missing)
  typeof console !== 'undefined' && console.warn(`[EvoFlow:right-stage] ${text}`)
  // 非阻断提示：复用现有 toast 通道（不存在时静默降级，绝不因此抛错）
  try {
    const g = globalThis as unknown as { evoflowToast?: (m: string, k?: string) => void }
    g.evoflowToast?.(text, 'warning')
  } catch {
    /* 提示失败不影响主流程 */
  }
}

/**
 * @returns 打开的 tab id；无法识别则空串
 */
export function openProgressFromPanelSet(
  surface: ProgressStageSurface | null | undefined,
  opts?: { sessionKey?: string | null; forceExpand?: boolean },
): string {
  if (!surface || typeof surface !== 'object') {
    logRightStage('openProgress:skip empty surface')
    return ''
  }
  const kind = normalizeRightStageKind(String(surface.kind || ''))
  const data = surface.data && typeof surface.data === 'object' ? surface.data : {}
  const title = firstStr(surface.title, data.title)
  const sk = firstStr(opts?.sessionKey, surface.sessionKey) || undefined
  const forceExpand = opts?.forceExpand === true

  if (kind === 'collab-workflow') {
    const mainTaskId = firstStr(data.mainTaskId, data.main_task_id, data.taskId, data.task_id)
    if (!mainTaskId) {
      // 【self-evolution-bot · 2026-11-20 · 第87轮 · 模型:deepseek-v4.1-flash-1017】
      // 改了什么：缺字段时按契约给出可读原因，不再静默 return ''。
      // 为什么：用户反馈「点了没反应 / 对不齐」——原来只有 console 日志，
      // 界面一片空白。现在按后端同一份契约生成「缺少 data.mainTaskId」提示。
      logRightStage('openProgress:collab-workflow missing mainTaskId', {
        dataKeys: Object.keys(data),
        missing: missingContractFields(kind, data),
      })
      notifyMissingFields(kind, data)
      return ''
    }
    const tabId = openCollabWorkflowInRightStage(
      {
        mainTaskId,
        leadThreadId: firstStr(data.leadThreadId, data.lead_thread_id, data.threadId, data.thread_id),
        title: title || '工作流',
      },
      { sessionKey: sk, layout: (surface.layout as 'half') || 'half', forceExpand },
    )
    logRightStage('openProgress:collab-workflow', { tabId, mainTaskId, title, forceExpand }, { store: rightStageStore })
    return tabId
  }

  if (kind === 'collabSubtaskTranscript') {
    const subtaskId = firstStr(data.subtaskId, data.subtask_id)
    const mainTaskId = firstStr(data.mainTaskId, data.main_task_id, data.taskId, data.task_id)
    if (!subtaskId) {
      notifyMissingFields(kind, data)
      return ''
    }
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
    // 契约真源（right_panel_kinds.py）同样只强制 agentCode，taskId 可选——两端口径一致。
    if (!agentCode) {
      notifyMissingFields(kind, data)
      return ''
    }
    const employeeSk = employeeOwnedSessionKey(
      firstStr(data.sessionKey, data.session_key, data.employeeSessionKey),
      agentCode,
    )
    return openEmployeeProcessInRightStage(
      {
        taskId: taskId || '',
        agentCode,
        roleName: firstStr(data.roleName, data.role_name),
        title: title || undefined,
        roundId: firstStr(data.roundId, data.round_id, data.source_ref),
        busy: data.busy !== false,
        employeeSessionKey: employeeSk || undefined,
      },
      { sessionKey: sk, layout: (surface.layout as 'wide') || 'wide' },
    )
  }

  if (kind === 'shell-page') {
    const path = firstStr(data.path, data.route, data.href, data.url)
    if (!path) {
      logRightStage('openProgress:shell-page missing path', { dataKeys: Object.keys(data) })
      notifyMissingFields(kind, data)
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
        focusId: firstStr(data.focusId, data.focus, data.itemId, data.item_id),
        layout: (surface.layout as 'wide') || 'wide',
      },
      // forceExpand 必须透传：用户点「查看事项/查看任务」时右栏可能处于收起锁，
      // 只写签不撑开 = 点了没反应（与 collab-workflow / employeeProcess 分支同口径）
      { sessionKey: sk, layout: (surface.layout as 'wide') || 'wide', forceExpand },
    )
    logRightStage(
      'openProgress:shell-page',
      { tabId, path, title: title || entityLabel, forceExpand },
      { store: rightStageStore },
    )
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
    k === 'sessionRuntime' ||
    k === 'shell-page'
  )
}
