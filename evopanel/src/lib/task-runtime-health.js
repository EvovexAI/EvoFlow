/**
 * Task Center：业务 lifecycle（账本 status）vs 运行时存活（在跑 / 进程失联）。
 *
 * 展示原则（2026-11）：
 * - **主状态永远跟数据库 lifecycle**（执行中 / 已完成 / 失败…）
 * - ``runtime_health=interrupted`` 只做附注「进程失联」，不把主文案改成「已中断」
 *   （否则 78% 执行中会被盖成莫名其妙的「已中断」，且说不清何时/为何）
 *
 * Prefer server field ``task.runtime_health`` (joined from ``evoflow_chat_sessions``
 * on list/detail). Client ``active-sessions`` index is only a fallback when the
 * API did not stamp health — never invent interrupted without a source of truth.
 *
 * Fallback join keys against GET /langgraph/active-sessions:
 *   - task.thread_id === session.thread_id
 *   - task.id === session.collab_task_id
 *   - task.id === session.main_task_id (workflow main task; thread_id is None there)
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
    // Workflow executor sessions carry main_task_id in context; workflow main
    // task rows have thread_id=None, so this is their only join key.
    const mainTaskId = String(s?.main_task_id || s?.mainTaskId || '').trim()
    if (tid) byThread.set(tid, s)
    if (taskId) byTaskId.set(taskId, s)
    if (mainTaskId) byTaskId.set(mainTaskId, s)
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
 * Prefer server-stamped ``runtime_health`` (from ``evoflow_chat_sessions`` join).
 * Client active-sessions probe is fallback only when the field is absent.
 *
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

  // Authoritative: list/detail API enriches from SQLite session run_status.
  const server = String(task.runtime_health || task.runtimeHealth || '')
    .trim()
    .toLowerCase()
  if (server === 'live' || server === 'interrupted' || server === 'idle') {
    return /** @type {TaskRuntimeHealth} */ (server)
  }
  if (task.run_alive === true || task.runAlive === true) return 'live'
  if (task.run_alive === false || task.runAlive === false) return 'interrupted'

  // No probe yet — don't guess (avoids flashing「进程失联」on first paint)
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
 * Format last ledger activity for tooltips / detail trail.
 * @param {any} task
 */
export function formatTaskLedgerActivityZh(task) {
  const ms = taskActivityMs(task)
  if (!ms) return ''
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * Explain runtime disconnect for title / detail (DB time + meaning).
 * @param {any} task
 * @param {TaskRuntimeHealth} [health]
 */
export function runtimeHealthExplainZh(task, health) {
  const h = health || resolveTaskRuntimeHealth(task, null)
  if (h === 'live') return '执行进程仍在运行（会话/租约存活）'
  if (h !== 'interrupted') return ''
  const when = formatTaskLedgerActivityZh(task)
  const base =
    '账本仍为进行中，但未检测到活跃会话或租约（进程可能已退出、崩溃或被停止）'
  return when ? `${base}。账本最近更新：${when}` : base
}

/**
 * Primary status label：永远以账本 lifecycle 为准；运行时只做后缀。
 * @param {any} task
 * @param {{ byThread: Map<string, any>, byTaskId: Map<string, any> } | null | undefined} index
 * @param {(status: unknown) => string} formatLifecycleZh
 */
export function formatTaskStatusWithRuntime(task, index, formatLifecycleZh) {
  const base = formatLifecycleZh(task?.status)
  const health = resolveTaskRuntimeHealth(task, index)
  if (health === 'live') {
    return base === '执行中' ? '执行中·在跑' : `${base}·在跑`
  }
  if (health === 'interrupted') {
    // 不盖成「已中断」——那是探测态，不是库里的终态
    return `${base}·进程失联`
  }
  return base
}

/** @type {Record<TaskRuntimeHealth, { label: string, tone: string }>} */
export const RUNTIME_HEALTH_UI = {
  live: { label: '在跑', tone: 'live' },
  interrupted: { label: '进程失联', tone: 'interrupted' },
  idle: { label: '', tone: 'idle' },
  'n/a': { label: '', tone: 'na' },
}

/**
 * Compact chip for runtime: 在跑 / 进程失联（附注，不替代账本状态）。
 * @param {TaskRuntimeHealth} health
 * @param {(s: string) => string} escapeHtml
 * @param {{ title?: string }} [opts]
 */
export function renderRuntimeHealthChip(health, escapeHtml, opts = {}) {
  if (health !== 'live' && health !== 'interrupted') return ''
  const esc = typeof escapeHtml === 'function' ? escapeHtml : (s) => String(s)
  const meta = RUNTIME_HEALTH_UI[health]
  const title = esc(opts.title || (health === 'live' ? '执行进程仍在运行' : '账本仍进行中，但进程已失联'))
  return `<span class="tl-runtime tl-runtime--${meta.tone}" title="${title}">${esc(meta.label)}</span>`
}

/** @deprecated use formatTaskStatusWithRuntime */
export function displayTaskStatusZh(task, index, lifecycleZh) {
  return formatTaskStatusWithRuntime(task, index, () => String(lifecycleZh || ''))
}

/**
 * Plain text suffix for detail status line.
 * @param {TaskRuntimeHealth} health
 */
export function runtimeHealthStatusSuffix(health) {
  if (health === 'live') return '进程在跑'
  if (health === 'interrupted') return '进程失联'
  return ''
}
