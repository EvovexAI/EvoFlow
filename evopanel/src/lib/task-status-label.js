/**
 * 任务 / 子任务 / 协作阶段 status 枚举 → 中文展示（侧栏、任务中心、详情页共用）
 *
 * 统一展示态（产品口径）：
 *   pending | planning | queued | running | waiting_confirmation | completed | failed | cancelled
 */

/** @typedef {'inbox'|'pending'|'planning'|'queued'|'running'|'waiting_confirmation'|'completed'|'failed'|'cancelled'} UnifiedTaskStatus */

export const UNIFIED_STATUS_ZH = {
  inbox: '待办',
  pending: '待处理',
  planning: '规划中',
  queued: '待执行',
  running: '执行中',
  waiting_confirmation: '待确认',
  completed: '已完成',
  failed: '异常',
  cancelled: '已取消',
}

/** 兼容旧 key → 中文（细分态）；统一展示优先走 UNIFIED_STATUS_ZH */
const STATUS_ZH = {
  inbox: '待办',
  pending: '待处理',
  planning: '规划中',
  planned: '待执行',
  queued: '待执行',
  executing: '执行中',
  in_progress: '执行中',
  running: '执行中',
  active: '执行中',
  paused: '已暂停',
  awaiting_close: '待确认',
  reviewed: '已完成',
  completed: '已完成',
  done: '已完成',
  success: '已完成',
  failed: '异常',
  error: '异常',
  cancelled: '已取消',
  canceled: '已取消',
  timed_out: '异常',
  blocked: '待处理',
  verifying: '执行中',
  reflecting: '执行中',
  idle: '待处理',
  req_confirm: '待确认',
  waiting_user: '待确认',
  waiting_confirmation: '待确认',
  plan_ready: '待执行',
  awaiting_exec: '待执行',
  waiting_dispatch: '执行中',
  archived: '已完成',
  deleted: '已取消',
}

const RUNNING_STATUSES = new Set([
  'executing', 'in_progress', 'running', 'active', 'verifying', 'reflecting',
  'waiting_dispatch',
])
const PLANNING_ONLY = new Set(['planning'])
const QUEUED_STATUSES = new Set(['planned', 'plan_ready', 'awaiting_exec', 'queued'])
const WAITING_CONFIRM = new Set(['req_confirm', 'waiting_user', 'awaiting_close', 'waiting_confirmation'])
const PAUSABLE_STATUSES = new Set([
  'pending', 'planning', 'planned', 'executing', 'running', 'in_progress', 'active',
  'awaiting_exec', 'waiting_dispatch', 'verifying', 'reflecting', 'queued',
])
const STARTABLE_STATUSES = new Set(['pending', 'paused', 'awaiting_exec', 'planned', 'plan_ready', 'queued'])
const TERMINAL_SUBTASK_OK = new Set(['completed', 'done', 'success', 'reviewed'])

export function normalizeTaskStatusKey(status) {
  return String(status || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
}

/**
 * 归一到产品统一态（8 态）
 * @param {string} [status]
 * @returns {UnifiedTaskStatus}
 */
export function toUnifiedTaskStatus(status) {
  const s = normalizeTaskStatusKey(status)
  if (!s) return 'pending'
  if (s === 'inbox') return 'inbox'
  if (s === 'completed' || s === 'done' || s === 'success' || s === 'archived' || s === 'reviewed') {
    return 'completed'
  }
  if (s === 'failed' || s === 'error' || s === 'timed_out') return 'failed'
  if (s === 'cancelled' || s === 'canceled' || s === 'deleted') return 'cancelled'
  if (WAITING_CONFIRM.has(s)) return 'waiting_confirmation'
  if (QUEUED_STATUSES.has(s)) return 'queued'
  if (PLANNING_ONLY.has(s)) return 'planning'
  if (RUNNING_STATUSES.has(s)) return 'running'
  if (s === 'paused' || s === 'pending' || s === 'idle' || s === 'blocked') return 'pending'
  return 'pending'
}

export function formatUnifiedStatusZh(status) {
  return UNIFIED_STATUS_ZH[toUnifiedTaskStatus(status)] || UNIFIED_STATUS_ZH.pending
}

export function isTaskRunningStatus(status) {
  return toUnifiedTaskStatus(status) === 'running'
}

export function isTaskPlanningStatus(status) {
  return toUnifiedTaskStatus(status) === 'planning'
}

export function isTaskQueuedStatus(status) {
  return toUnifiedTaskStatus(status) === 'queued'
}

export function isTaskWaitingConfirmation(status) {
  return toUnifiedTaskStatus(status) === 'waiting_confirmation'
}

export function isTaskPausableStatus(status) {
  const key = normalizeTaskStatusKey(status)
  return PAUSABLE_STATUSES.has(key) && key !== 'paused'
}

export function isTaskStartableStatus(status) {
  return STARTABLE_STATUSES.has(normalizeTaskStatusKey(status))
}

/** 可取消：未进入终态（已完成 / 失败 / 已取消） */
export function isTaskCancellableStatus(status) {
  const u = toUnifiedTaskStatus(status)
  return u !== 'completed' && u !== 'failed' && u !== 'cancelled'
}

export function countPausableByScope(tasks, scope) {
  const list = Array.isArray(tasks) ? tasks : []
  if (scope === 'running') {
    return list.filter(t =>
      isTaskRunningStatus(t.status) || isTaskPlanningStatus(t.status)
    ).length
  }
  return list.filter(t => isTaskPausableStatus(t.status)).length
}

export function isSubtaskCompletedStatus(status) {
  return TERMINAL_SUBTASK_OK.has(normalizeTaskStatusKey(status))
}

/** @param {string} [status] @param {{ fallback?: string }} [opts] */
export function formatTaskStatusZh(status, opts = {}) {
  const fallback = opts.fallback ?? '待处理'
  const key = normalizeTaskStatusKey(status)
  if (!key) return fallback
  // 统一展示优先；细分 key 有专属文案时用专属
  if (STATUS_ZH[key]) return STATUS_ZH[key]
  return formatUnifiedStatusZh(status) || fallback
}

/** 任务详情页子任务 tag 的 CSS 修饰类 */
export function taskStatusTagClass(status) {
  const u = toUnifiedTaskStatus(status)
  const map = {
    inbox: 'tag--pending',
    pending: 'tag--pending',
    planning: 'tag--pending',
    queued: 'tag--pending',
    running: 'tag--executing',
    waiting_confirmation: 'tag--paused',
    completed: 'tag--completed',
    failed: 'tag--failed',
    cancelled: 'tag--canceled',
  }
  return map[u] || 'tag--subtle'
}

/** React 侧栏 / RunManager 状态徽标 class */
export function taskStatusBadgeClass(status) {
  const u = toUnifiedTaskStatus(status)
  if (u === 'completed') return 'task-status-completed'
  if (u === 'failed') return 'task-status-failed'
  if (u === 'running' || u === 'planning') return 'task-status-progress'
  return 'task-status-pending'
}

/**
 * 把任意 task/subtask 状态归并到监控/筛选分组：
 *   executing | planning | pending | paused | completed | failed | cancelled
 *
 * 说明：planned/待执行 归 pending（主标签「待处理」）；awaiting_close 归 pending（待确认）
 */
export function toTaskStatusGroup(status) {
  const s = normalizeTaskStatusKey(status)
  if (!s) return 'pending'
  if (s === 'inbox') return 'inbox'
  if (s === 'completed' || s === 'done' || s === 'success' || s === 'archived' || s === 'reviewed') {
    return 'completed'
  }
  if (s === 'failed' || s === 'error' || s === 'timed_out') return 'failed'
  if (s === 'cancelled' || s === 'canceled' || s === 'deleted') return 'cancelled'
  if (s === 'paused') return 'paused'
  if (
    s === 'executing' ||
    s === 'in_progress' ||
    s === 'running' ||
    s === 'active' ||
    s === 'verifying' ||
    s === 'reflecting' ||
    s === 'waiting_dispatch'
  ) {
    return 'executing'
  }
  // 仅真正规划中
  if (s === 'planning') return 'planning'
  // 待确认 / 待执行 / 待处理 → pending 组（主标签「待处理」）
  return 'pending'
}

/**
 * 主标签筛选：待处理含 planning/queued/waiting_confirmation
 * @param {string} status
 * @param {string|null|undefined} tabKey STATUS_GROUPS / MAIN tab 的 status key
 */
export function taskMatchesStatusTab(status, tabKey) {
  if (!tabKey) return true
  const u = toUnifiedTaskStatus(status)
  if (tabKey === 'todo') {
    // 「待办」= 所有未完成任务（未派发/待处理/规划中/待执行/执行中/待确认）
    return u !== 'completed' && u !== 'failed' && u !== 'cancelled'
  }
  if (tabKey === 'inbox') return u === 'inbox'
  if (tabKey === 'pending') {
    // 「待处理」不含随手待办（单独 Tab）
    return u === 'pending' || u === 'planning' || u === 'queued' || u === 'waiting_confirmation'
  }
  if (tabKey === 'executing' || tabKey === 'running') return u === 'running'
  if (tabKey === 'completed') return u === 'completed'
  if (tabKey === 'failed' || tabKey === 'exception') return u === 'failed'
  if (tabKey === 'cancelled') return u === 'cancelled'
  if (tabKey === 'planning') return u === 'planning'
  return toTaskStatusGroup(status) === tabKey
}

/**
 * 执行进度（与阶段状态分离）：
 * - planning / queued：不展示伪 100%
 * - cancelled：保留取消前进度，否则 null（展示 --）
 * - completed：100
 * - running / waiting_confirmation：按子任务或 progress 字段
 */
export function computeTaskExecutionProgress(task, subtasks) {
  const list = Array.isArray(subtasks) && subtasks.length
    ? subtasks
    : (Array.isArray(task?.subtasks) ? task.subtasks : [])
  const subtaskCount = list.length
  const completedCount = list.filter((s) => isSubtaskCompletedStatus(s.status)).length
  const u = toUnifiedTaskStatus(task?.status)
  const raw = Number(task?.progress)
  const rawOk = Number.isFinite(raw) && raw >= 0 ? Math.round(Math.min(100, raw)) : null

  /** @type {number|null} */
  let progress = null
  let showPercent = false
  let label = formatUnifiedStatusZh(task?.status)

  if (u === 'completed') {
    progress = 100
    showPercent = true
    label = '已完成'
  } else if (u === 'cancelled') {
    // 不得默认 100%；有真实进度才显示
    if (rawOk != null && rawOk > 0 && rawOk < 100) {
      progress = rawOk
      showPercent = true
    } else if (subtaskCount > 0 && completedCount > 0 && completedCount < subtaskCount) {
      progress = Math.round((completedCount / subtaskCount) * 100)
      showPercent = true
    } else {
      progress = null
      showPercent = false
    }
    label = '已取消'
  } else if (u === 'planning') {
    progress = null
    showPercent = false
    label = '规划中'
  } else if (u === 'queued') {
    progress = null
    showPercent = false
    label = '规划已完成，等待执行'
  } else if (u === 'pending') {
    progress = null
    showPercent = false
    label = formatTaskStatusZh(task?.status, { fallback: '待处理' })
  } else if (u === 'running' || u === 'waiting_confirmation' || u === 'failed') {
    if (subtaskCount > 0) {
      progress = Math.round((completedCount / subtaskCount) * 100)
      showPercent = true
    } else if (rawOk != null && rawOk > 0) {
      progress = rawOk
      showPercent = true
    } else {
      progress = 0
      showPercent = u === 'running'
    }
    if (u === 'waiting_confirmation') label = '待确认'
    else if (u === 'failed') label = '异常'
    else label = '执行中'
  }

  return {
    unified: u,
    progress,
    showPercent,
    label,
    subtaskCount,
    completedCount,
  }
}
