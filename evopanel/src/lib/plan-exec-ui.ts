/** Plan exec strip: when to show「开始执行」vs status-only row. */

import {
  listHasSuccessfulPlanTool,
  planToolCallIdIfSuccess,
  toolRowMatchesCallId,
} from './collab-sidebar-from-tools.js'
import {
  formatPlanTaskStatusLabel,
  isPlanAwaitingUserExecStart,
  isTaskExecutionAuthorized,
} from './plan-task-status.js'
import { normalizeTaskStatusKey } from './task-status-label.js'

export type PlanExecHost =
  | { kind: 'none' }
  | { kind: 'row'; index: number }
  | { kind: 'stream' }

export type PlanExecUiInput = {
  status?: string
  lifecycleStage?: string
  lifecycleLabel?: string
  collabPhase?: string
  executionAuthorized?: boolean
  /** 计划正文已绑定（plan 工具成功），应展示「开始执行」 */
  boundPlanReady?: boolean
  /** 消息流中已有成功的 plan 工具（hydrate 未及时带上 boundPlanReady 时的兜底） */
  hasPlanToolSuccess?: boolean
}

/** 是否为「是否开始执行」类 ask_clarification（应由 PlanExecConfirm 条承担，勿在下方询问区展示） */
export function isPlanExecutionConfirmationClarification(
  preview: string | undefined | null,
  input?: Record<string, unknown> | null,
): boolean {
  // Structured category takes precedence over regex matching
  if (input?.category === 'plan_execution_confirm') return true
  const question = String(
    input?.question ?? input?.prompt ?? input?.content ?? preview ?? '',
  ).trim()
  if (!question) return false
  const opts: string[] = []
  const rawOpts = input?.options
  if (Array.isArray(rawOpts)) {
    for (const op of rawOpts) {
      if (typeof op === 'string') opts.push(op.trim())
      else if (op && typeof op === 'object') {
        const lb = String((op as { label?: string; text?: string }).label ?? (op as { text?: string }).text ?? '').trim()
        if (lb) opts.push(lb)
      }
    }
  }
  const hasStart = opts.some((lb) => /开始执行|按计划执行/.test(lb))
  const hasModify = opts.some((lb) => /继续修改计划/.test(lb))
  if (hasStart && hasModify) return true
  if (hasStart && /计划已就绪|是否现在|是否开始执行|是否继续执行/.test(question)) return true
  if (/计划已就绪/.test(question) && /开始执行|是否/.test(question)) return true
  // 收紧：必须同时包含「计划」关键词，避免普通澄清问题误命中
  if (/计划/.test(question) && /确认/.test(question) && /执行/.test(question) && /是否|请/.test(question)) return true
  return false
}

/** 计划确认条已展示时，隐藏助手重复的「计划已落库 / 请回复开始执行」话术 */
export function isPlanExecPromptAssistantNoise(text: string): boolean {
  const t = String(text || '').trim()
  if (!t) return false
  if (t.length > 800) return false
  if (/计划已落库|Plan\s*已落库/i.test(t) && /开始执行/.test(t)) return true
  if (/计划已就绪/.test(t) && /开始执行|是否/.test(t)) return true
  if (/请回复.{0,16}开始执行/.test(t) && /落库|已定稿|plan/i.test(t)) return true
  if (/^计划已落库[。.!]?\s*$/i.test(t)) return true
  return false
}

/** Gateway ``dispatch`` / supervisor ``start_execution`` actually started workers. */
export function isExecutionDispatchStarted(
  dispatch: unknown,
  opts?: { collabPhase?: string },
): boolean {
  const phase = String(opts?.collabPhase || '')
    .trim()
    .toLowerCase()
  if (phase === 'executing') return true
  if (!dispatch || typeof dispatch !== 'object') return false
  const d = dispatch as Record<string, unknown>
  if (d.success !== true) return false
  const ids = d.subtaskIds
  if (Array.isArray(ids) && ids.length > 0) return true
  const delegated = d.delegatedSubtasks
  if (Array.isArray(delegated)) {
    return delegated.some(
      (row) => row && typeof row === 'object' && (row as { ok?: boolean }).ok === true,
    )
  }
  return false
}

/** User-visible hint when authorize succeeded but dispatch did not start workers. */
export function executionDispatchFailureHint(dispatch: unknown): string {
  if (!dispatch || typeof dispatch !== 'object') {
    return '已授权，但未能自动派发子任务，正在通过对话触发执行…'
  }
  const d = dispatch as Record<string, unknown>
  const err = String(d.error || '').trim()
  const msg = String(d.message || '').trim()
  if (err === 'no_runnable_subtasks' || err === 'no_subtasks') {
    return '已授权，但没有可运行的子任务（请检查依赖、执行人或子任务状态）'
  }
  if (err === 'delegation_failed' || d.delegationAllSucceeded === false) {
    return '已授权，子任务派发失败，正在通过对话重试…'
  }
  if (msg) return msg
  return '已授权，但未能自动派发子任务，正在通过对话触发执行…'
}

/** Whether authorize-execution / dispatch-execution API returned runnable workers. */
export function apiDispatchStarted(dispatch: Record<string, unknown> | null | undefined): boolean {
  if (!dispatch || dispatch.success === false) return false
  const ids = dispatch.subtaskIds
  if (Array.isArray(ids) && ids.length > 0) return true
  const delegated = dispatch.delegatedSubtasks
  if (Array.isArray(delegated)) {
    return delegated.some((d) => typeof d === 'object' && d && (d as Record<string, unknown>).ok)
  }
  return dispatch.success === true
}

/** First actionable error from authorize/dispatch ``dispatch`` payload (e.g. delegation weakref). */
export function extractDispatchErrorMessage(dispatch: unknown): string {
  if (!dispatch || typeof dispatch !== 'object') return ''
  const d = dispatch as Record<string, unknown>
  if (d.success !== false && apiDispatchStarted(d)) return ''
  const delegated = d.delegatedSubtasks
  if (Array.isArray(delegated)) {
    for (const row of delegated) {
      if (!row || typeof row !== 'object') continue
      const err = String((row as Record<string, unknown>).error || '').trim()
      if (err) return err
    }
  }
  return String(d.error || d.message || '').trim()
}

export function computePlanExecStripUi(input: PlanExecUiInput): {
  showStartExecution: boolean
  statusLabel: string
} {
  const task = {
    status: input.status,
    executionAuthorized: input.executionAuthorized,
  }
  const planReady = !!(input.boundPlanReady || input.hasPlanToolSuccess)
  const label = formatPlanTaskStatusLabel(task)

  if (
    isPlanAwaitingUserExecStart(task, {
      hasPlanBody: planReady,
      boundPlanReady: input.boundPlanReady,
    })
  ) {
    return { showStartExecution: true, statusLabel: label }
  }

  if (isTaskExecutionAuthorized(task)) {
    return { showStartExecution: false, statusLabel: label }
  }

  const st = normalizeTaskStatusKey(input.status)
  if (st === 'planning') {
    return { showStartExecution: false, statusLabel: label }
  }

  return { showStartExecution: false, statusLabel: label || '已定稿' }
}

function rowHasAnchoredPlanTool(tools: unknown[] | undefined, anchorToolCallId: string): boolean {
  if (!Array.isArray(tools)) return false
  const anchor = String(anchorToolCallId || '').trim()
  if (anchor) {
    for (const tool of tools) {
      if (toolRowMatchesCallId(tool, anchor) && planToolCallIdIfSuccess(tool)) return true
    }
    return false
  }
  return listHasSuccessfulPlanTool(tools)
}

/**
 * Which chat row may show the plan exec confirm strip (only one row).
 * Mirrors resolveToolApprovalHost: stream bubble while plan tool completes, else the assistant turn that ran plan.
 */
/** Resolve main task id when plan output omitted boundTaskId (bind lag / legacy rows). */
export async function resolvePlanBoundTaskId(input: {
  sessionKey?: string
  hintTaskId?: string
  planOutput?: Record<string, unknown> | null
}): Promise<string> {
  const hint = String(input.hintTaskId || '').trim()
  if (hint) return hint

  const o = input.planOutput
  if (o && typeof o === 'object') {
    const fromCreated = (() => {
      const sync = o.subtasksSync as Record<string, unknown> | undefined
      const tid = String(o.boundTaskId || o.bound_task_id || sync?.task_id || sync?.taskId || '').trim()
      if (tid) return tid
      const created = Array.isArray(o.created)
        ? o.created
        : Array.isArray(sync?.created)
          ? sync.created
          : []
      for (const row of created) {
        if (!row || typeof row !== 'object') continue
        const p = String(
          (row as { parentTaskId?: string; parent_task_id?: string }).parentTaskId ||
            (row as { parent_task_id?: string }).parent_task_id ||
            '',
        ).trim()
        if (p) return p
      }
      return ''
    })()
    if (fromCreated) return fromCreated
  }

  const sessionKey = String(input.sessionKey || '').trim()
  if (!sessionKey) return ''

  try {
    const { fetchTaskRowBySessionKey } = await import('./plan-from-api.js')
    const row = await fetchTaskRowBySessionKey(sessionKey, { preferTaskId: hint || undefined })
    const id = String(
      (row as { id?: string; taskId?: string; task_id?: string } | null)?.id ||
        (row as { taskId?: string } | null)?.taskId ||
        (row as { task_id?: string } | null)?.task_id ||
        '',
    ).trim()
    if (id) return id
  } catch {
    /* ignore */
  }
  return ''
}

export function resolvePlanExecHost(input: {
  rows: Array<{ role?: string; tools?: unknown[] }>
  streamTools?: unknown[]
  isSending?: boolean
  anchorToolCallId?: string
  hasConfirm?: boolean
}): PlanExecHost {
  if (!input.hasConfirm) return { kind: 'none' }

  const list = Array.isArray(input.rows) ? input.rows : []
  const last = list[list.length - 1]
  const lastIsUser = last?.role === 'user'
  const streamTools = Array.isArray(input.streamTools) ? input.streamTools : []
  const anchor = String(input.anchorToolCallId || '').trim()

  if (lastIsUser) {
    if (rowHasAnchoredPlanTool(streamTools, anchor)) {
      return { kind: 'stream' }
    }
    if (input.isSending && listHasSuccessfulPlanTool(streamTools)) {
      return { kind: 'stream' }
    }
  }

  for (let i = list.length - 1; i >= 0; i--) {
    const row = list[i]
    if (row?.role !== 'assistant') continue
    if (rowHasAnchoredPlanTool(row.tools, anchor)) return { kind: 'row', index: i }
  }

  // Sidebar-hydrated confirm without a plan tool row in transcript yet
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === 'assistant') return { kind: 'row', index: i }
  }

  return { kind: 'none' }
}
