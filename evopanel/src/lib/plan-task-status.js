/**
 * 计划相关 UI 只认主任务表 ``evoflow_collab_tasks.status``（+ 同行 execution_authorized 门禁）。
 * 不再用 lifecycleStage / collab_phase 推断计划态。
 */

import { formatTaskStatusZh, normalizeTaskStatusKey } from './task-status-label.js'

/** 底部「开始执行」条唯一展示态：已定稿、待用户授权 */
export const PLAN_DOCK_TASK_STATUS = 'planned'

const TERMINAL_TASK_STATUSES = new Set(['completed', 'done', 'failed', 'cancelled', 'canceled', 'timed_out'])
const ACTIVE_EXEC_TASK_STATUSES = new Set(['executing', 'running', 'in_progress', 'waiting_dispatch'])

/**
 * @param {{ status?: string; executionAuthorized?: boolean; boundPlanReady?: boolean } | null | undefined} task
 */
export function isTaskExecutionAuthorized(task) {
  return task?.executionAuthorized === true || task?.executionAuthorized === 1
}

/**
 * @param {string} [status]
 */
export function isTerminalTaskStatus(status) {
  return TERMINAL_TASK_STATUSES.has(normalizeTaskStatusKey(status))
}

/**
 * @param {string} [status]
 */
export function isActiveExecTaskStatus(status) {
  return ACTIVE_EXEC_TASK_STATUSES.has(normalizeTaskStatusKey(status))
}

/**
 * 主任务 status=planned 且未授权 → 展示计划确认条。
 * @param {{ status?: string; executionAuthorized?: boolean } | null | undefined} task
 * @param {{ hasPlanBody?: boolean; boundPlanReady?: boolean }} [opts]
 */
export function isPlanAwaitingUserExecStart(task, opts = {}) {
  const hasBody = !!opts.hasPlanBody || !!opts.boundPlanReady || !!task?.boundPlanReady
  if (!hasBody) return false
  if (isTaskExecutionAuthorized(task)) return false
  let st = normalizeTaskStatusKey(task?.status)
  const planBound = !!(opts.boundPlanReady || task?.boundPlanReady)
  if ((!st || st === 'planning') && planBound) {
    st = PLAN_DOCK_TASK_STATUS
  }
  if (st === 'planning' && hasBody) {
    st = PLAN_DOCK_TASK_STATUS
  }
  if (!st || st === 'planning') return false
  if (isTerminalTaskStatus(st) || isActiveExecTaskStatus(st)) return false
  return st === PLAN_DOCK_TASK_STATUS
}

/**
 * @param {{ status?: string; executionAuthorized?: boolean } | null | undefined} task
 */
export function formatPlanTaskStatusLabel(task) {
  const st = normalizeTaskStatusKey(task?.status)
  if (st === PLAN_DOCK_TASK_STATUS) {
    return isTaskExecutionAuthorized(task) ? '已授权，待启动' : '待授权开始执行'
  }
  return formatTaskStatusZh(st, { fallback: '待处理' })
}

/**
 * @param {{
 *   collabTask?: { status?: string; executionAuthorized?: boolean; boundPlanReady?: boolean } | null
 *   hasPlanBody?: boolean
 * }} input
 */
export function isPlanExecDockEligible(input) {
  return isPlanAwaitingUserExecStart(input.collabTask, {
    hasPlanBody: input.hasPlanBody,
    boundPlanReady: input.collabTask?.boundPlanReady,
  })
}

/**
 * 计划正文是否已落库（有 goal / boundPlanReady）。
 * @param {{ boundPlanReady?: boolean; planGoal?: string; boundPlanPreview?: string } | null | undefined} task
 * @param {{ hasPlanBody?: boolean; boundPlanReady?: boolean }} [opts]
 */
export function isPlanFormulated(task, opts = {}) {
  if (opts.hasPlanBody || opts.boundPlanReady || task?.boundPlanReady) return true
  if (String(task?.planGoal || task?.boundPlanPreview || '').trim()) return true
  return false
}

/**
 * 右侧协作侧栏子任务列表：仅两种状态不展示——① 计划未制定 ② 计划已定稿但未授权。
 * 展示条目始终以 GET /tasks → ``subtasks`` 为准，不合并流式占位。
 * @param {{ status?: string; executionAuthorized?: boolean; boundPlanReady?: boolean; planGoal?: string; boundPlanPreview?: string } | null | undefined} task
 * @param {{ execConfirmPending?: boolean; boundPlanReady?: boolean; hasPlanBody?: boolean }} [opts]
 */
export function shouldShowCollabSubtaskSidebar(task, opts = {}) {
  if (opts.execConfirmPending) return false
  if (!isPlanFormulated(task, opts)) return false
  if (isPlanAwaitingUserExecStart(task, opts)) return false
  return true
}

/**
 * 右侧工作流 DAG 面板：计划已制定即展示（含待授权开始执行），终态任务不展示。
 * 与 {@link shouldShowCollabSubtaskSidebar} 不同：不因 execConfirmPending 隐藏结构预览。
 */
export function shouldShowCollabWorkflowPanel(task, opts = {}) {
  if (!isPlanFormulated(task, opts)) return false
  if (isTerminalTaskStatus(task?.status)) return false
  return true
}

/**
 * 右侧协作执行 DAG 面板：仅执行中自动展开；主任务已终态则不自动展示。
 * @param {{ status?: string; executionAuthorized?: boolean; boundPlanReady?: boolean; planGoal?: string; boundPlanPreview?: string } | null | undefined} task
 * @param {{ execConfirmPending?: boolean; boundPlanReady?: boolean; hasPlanBody?: boolean; collabPhase?: string }} [opts]
 */
export function shouldAutoOpenCollabExecPanel(task, opts = {}) {
  if (!shouldShowCollabWorkflowPanel(task, opts)) return false
  const phase = String(opts.collabPhase || '').trim().toLowerCase()
  if (phase === 'executing' || phase === 'verifying' || phase === 'reflecting') return true
  return isActiveExecTaskStatus(task?.status)
}
