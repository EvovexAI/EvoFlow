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
// 【self-evolution-bot · 2026-11-20 · 第95轮 · 模型:deepseek-v4.1-flash-1017】
// 改了什么：补 sessionRuntime 的 opener 导入。
// 为什么：本文件新增 sessionRuntime 分支，此前它只在 isProgressStageKind 名单里
// 存在实现为零，ui.show 传进来会被静默丢弃。
import { openSessionRuntimeInRightStage } from './open-session-runtime-stage.js'
import type { SessionChildWorkItem } from '../../react/lib/session-reattach.js'
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
      // 【self-evolution-bot · 2026-11-20 · 第95轮 · 模型:deepseek-v4.1-flash-1017】
      // 改了什么：补 forceExpand 透传。
      // 为什么：实测 `ui.show(kind=collabSubtaskTranscript, expand=true)` 只建签不激活
      // （矩阵第 7 步：标签出现但 aria-selected 仍在旧签）。同批其它进度 kind 都透传了，
      // 唯独这条漏了。
      { sessionKey: sk, layout: (surface.layout as 'wide') || 'wide', forceExpand },
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
        // 【self-evolution-bot · 2026-11-20 · 第95轮 · 模型:deepseek-v4.1-flash-1017】
        // 改了什么：把后端新下发的 roundStamp（本次派发时刻）透传给签。
        // 为什么：roundId 在派单路径恒为空（后端 in-process 分支不回真实轮次），
        // 只靠它判「换轮」等于死代码——派了新任务右栏仍钉着用户上次手挑的历史对话。
        // roundStamp 每轮必变，且不参与任何会话键拼接，只喂「该不该继承旧会话」。
        roundStamp: firstStr(data.roundStamp, data.round_stamp),
        busy: data.busy !== false,
        employeeSessionKey: employeeSk || undefined,
      },
      // 【self-evolution-bot · 2026-11-20 · 第95轮 · 模型:deepseek-v4.1-flash-1017】
      // 改了什么：补 forceExpand 透传（原来这里只传 sessionKey/layout）。
      // 为什么：矩阵实测 `ui.show(kind=employeeProcess, expand=true)` 既没切激活、
      // 标题也没更新——store.show 收到 forceExpand 才走 shouldActivate 分支。
      { sessionKey: sk, layout: (surface.layout as 'wide') || 'wide', forceExpand },
    )
  }

  // 【self-evolution-bot · 2026-11-20 · 第95轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：补 sessionRuntime 分支（本函数此前完全没有它）。
  // 为什么：`isProgressStageKind()` 声明了 sessionRuntime 属进度类、契约真源
  // right_panel_kinds.py 也列了它并强制 data.sessionKey，但这里没有对应实现 ——
  // 实测 `ui.show(kind=sessionRuntime, expand=true)` 标签一条都没出现（静默丢弃），
  // 用户侧表现为「点了没反应」。openSessionRuntimeInRightStage 早已存在且支持
  // forceExpand，只是从来没有被这条链路调用。
  if (kind === 'sessionRuntime') {
    const runtimeSk = firstStr(data.sessionKey, data.session_key) || sk || ''
    if (!runtimeSk) {
      logRightStage('openProgress:sessionRuntime missing sessionKey', {
        dataKeys: Object.keys(data),
      })
      notifyMissingFields(kind, data)
      return ''
    }
    const works = Array.isArray(data.works) ? (data.works as SessionChildWorkItem[]) : []
    const tabId = openSessionRuntimeInRightStage({
      sessionKey: runtimeSk,
      focusKind: firstStr(data.focusKind, data.focus_kind) || null,
      works,
      forceExpand,
    })
    logRightStage(
      'openProgress:sessionRuntime',
      { tabId, sessionKey: runtimeSk, worksCount: works.length, forceExpand },
      { store: rightStageStore },
    )
    return tabId
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

// 【self-evolution-bot · 2026-11-20 · 第95轮续 · 模型:qwen3.8-flash】
// 改了什么：把 openProgressFromPanelSet 挂到 window.__EVOFLOW_RIGHT_STAGE_PROBE__（仅浏览器环境，重复挂载幂等）。
// 为什么：装后复验「派单→右栏实时显示→能续聊」这条链路时，update/show 的抢焦点判据
//   （pinAlive）只有 store 内部能走到，而 store 模块没有任何 window 出口——CDP 探针
//   只能量 DOM、注入不了事件，导致「反证档③（注入旧逻辑该红）」永远做不了，
//   第95轮装机后这一项就是这么漏掉的。本出口走的是与 SSE 完全相同的真入口
//   （openProgressFromPanelSet），不是函数层自测；探针注入后仍要拿 DOM/日志证真。
if (typeof window !== 'undefined') {
  const w = window as unknown as {
    __EVOFLOW_RIGHT_STAGE_PROBE__?: typeof openProgressFromPanelSet
  }
  if (!w.__EVOFLOW_RIGHT_STAGE_PROBE__) {
    w.__EVOFLOW_RIGHT_STAGE_PROBE__ = openProgressFromPanelSet
  }
}
