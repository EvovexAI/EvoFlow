/**
 * Task Center：业务 lifecycle（执行中）vs 运行时存活（在跑 / 已中断）。
 *
 * Join keys against GET /langgraph/active-sessions:
 *   - task.thread_id === session.thread_id
 *   - task.id === session.collab_task_id
 */

import {
  isTaskPlanningStatus,
  isTaskQueuedStatus,
  isTaskRunningStatus,
  toUnifiedTaskStatus,
} from './task-status-label.js'

/** @typedef {'live' | 'interrupted' | 'idle' | 'n/a'} TaskRuntimeHealth */

/**
 * @param {unknown} sessionsRes
 * @returns {any[]}
 */
export function asActiveSessionList(sessionsRes) {
  if (Array.isArray(sessionsRes)) return sessionsRes
  if (sessionsRes && typeof sessionsRes === 'object') {
    const o = /** @type {Record<string, unknown>} */ (sessionsRes)
    if (Array.isArray(o.active_sessions)) return o.active_sessions
    if (Array.isArray(o.sessions)) return o.sessions
  }
  return []
}

/**
 * Build lookup indexes from active sessions.
 * @param {any[]} sessions
 */
export function buildActiveSessionIndex(sessions) {
  /** @type {Map<string, any>} */
  const byThread = new Map()
  /** @type {Map<string, any>} */
  const byTaskId = new Map()
  for (const s of Array.isArray(sessions) ? sessions : []) {
    const tid = String(s?.thread_id || s?.threadId || '').trim()
    const taskId = String(s?.collab_task_id || s?.collabTaskId || '').trim()
    if (tid) byThread.set(tid, s)
    if (taskId) byTaskId.set(taskId, s)
  }
  return { byThread, byTaskId }
}

/**
 * Whether lifecycle says the task is still "in flight" (could have a live run).
 * @param {unknown} status
 */
export function isLifecycleInFlight(status) {
  return (
    isTaskRunningStatus(status) ||
    isTaskPlanningStatus(status) ||
    isTaskQueuedStatus(status)
  )
}

/**
 * Parse task updated/created time for age heuristics.
 * @param {any} task
 */
export function taskActivityMs(task) {
  const raw =
    task?.updated_at ||
    task?.updatedAt ||
    task?.started_at ||
    task?.startedAt ||
    task?.created_at ||
    task?.createdAt ||
    ''
  if (raw == null || raw === '') return 0
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw < 1e12 ? raw * 1000 : raw
  }
  const t = Date.parse(String(raw))
  return Number.isFinite(t) ? t : 0
}

/** In-flight with no heartbeat for this long → treat as interrupted even before reclaim. */
export const STALE_IN_FLIGHT_MS = 2 * 60 * 60 * 1000 // 2h

/**
 * @param {any} task
 * @param {{ byThread: Map<string, any>, byTaskId: Map<string, any> } | null | undefined} index
 * @param {{ nowMs?: number }} [opts]
 * @returns {TaskRuntimeHealth}
 */
export function resolveTaskRuntimeHealth(task, index, opts = {}) {
  if (!task) return 'n/a'
  const u = toUnifiedTaskStatus(task.status)
  // Terminal / waiting human / paused → no live worker expected
  if (
    u === 'completed' ||
    u === 'failed' ||
    u === 'cancelled' ||
    u === 'waiting_confirmation' ||
    u === 'inbox' ||
    u === 'pending'
  ) {
    return 'idle'
  }
  if (!isLifecycleInFlight(task.status)) return 'idle'

  // No probe yet — don't guess (avoids flashing「已中断」on first paint)
  if (!index) return 'n/a'

  const threadId = String(
    task.thread_id ||
      task.threadId ||
      task.current_execution_thread_id ||
      task.currentExecutionThreadId ||
      '',
  ).trim()
  const taskId = String(task.id || task.task_id || '').trim()

  const hit =
    (threadId && index.byThread.get(threadId)) ||
    (taskId && index.byTaskId.get(taskId)) ||
    null

  if (hit) return 'live'

  // No active session. Also flag age so multi-day zombies are obvious.
  const nowMs = Number(opts.nowMs) || Date.now()
  const activity = taskActivityMs(task)
  if (activity > 0 && nowMs - activity >= STALE_IN_FLIGHT_MS) {
    return 'interrupted'
  }
  // Fresh in-flight but session already gone (crash / stop mid-run)
  return 'interrupted'
}

/**
 * Primary status label for Task Center when runtime is interrupted.
 * Prefer this over raw「执行中」so zombies are not mistaken for live work.
 * @param {any} task
 * @param {{ byThread: Map<string, any>, byTaskId: Map<string, any> } | null | undefined} index
 * @param {(status: unknown) => string} formatLifecycleZh
 */
export function formatTaskStatusWithRuntime(task, index, formatLifecycleZh) {
  const health = resolveTaskRuntimeHealth(task, index)
  if (health === 'interrupted') return '已中断'
  if (health === 'live') {
    const base = formatLifecycleZh(task?.status)
    return base === '执行中' ? '执行中·在跑' : `${base}·在跑`
  }
  return formatLifecycleZh(task?.status)
}

/** @type {Record<TaskRuntimeHealth, { label: string, tone: string }>} */
export const RUNTIME_HEALTH_UI = {
  live: { label: '在跑', tone: 'live' },
  interrupted: { label: '已中断', tone: 'interrupted' },
  idle: { label: '', tone: 'idle' },
  'n/a': { label: '', tone: 'na' },
}

/**
 * Compact chip: only「在跑」.「已中断」is the primary status label (not a chip).
 * @param {TaskRuntimeHealth} health
 * @param {(s: string) => string} escapeHtml
 */
export function renderRuntimeHealthChip(health, escapeHtml) {
  if (health !== 'live') return ''
  const esc = typeof escapeHtml === 'function' ? escapeHtml : (s) => String(s)
  return `<span class="tl-runtime tl-runtime--live" title="${esc('执行进程仍在运行')}">${esc('在跑')}</span>`
}

/** @deprecated use formatTaskStatusWithRuntime */
export function displayTaskStatusZh(task, index, lifecycleZh) {
  if (resolveTaskRuntimeHealth(task, index) === 'interrupted') return '已中断'
  return String(lifecycleZh || '')
}

/**
 * Plain text suffix for detail status line.
 * @param {TaskRuntimeHealth} health
 */
export function runtimeHealthStatusSuffix(health) {
  if (health === 'live') return '进程在跑'
  if (health === 'interrupted') return '进程已停'
  return ''
}
