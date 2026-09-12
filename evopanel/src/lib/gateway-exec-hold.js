/**
 * Plan 执行中 hold：gateway-guardian 在活跃 Plan 执行期间推迟自动 reload。
 */
import { isActiveExecTaskStatus, isTerminalTaskStatus } from './plan-task-status.js'

/** @type {Map<string, { threadId: string, since: number }>} */
const _active = new Map()

function taskIdFromRow(row) {
  return String(row?.id || row?.taskId || row?.task_id || '').trim()
}

export function registerPlanExecution(taskId, threadId = '') {
  const id = String(taskId || '').trim()
  if (!id) return
  const prev = _active.get(id)
  _active.set(id, {
    threadId: String(threadId || prev?.threadId || '').trim(),
    since: prev?.since || Date.now(),
  })
}

export function unregisterPlanExecution(taskId) {
  const id = String(taskId || '').trim()
  if (id) _active.delete(id)
}

export function clearPlanExecutionHold() {
  _active.clear()
}

/**
 * 根据单条主任务行更新 hold（仅增删该 taskId，不影响其它会话任务）。
 * @param {Record<string, unknown> | null | undefined} row
 */
export function syncPlanExecHoldFromTaskRow(row) {
  if (!row || typeof row !== 'object') return
  const taskId = taskIdFromRow(row)
  if (!taskId) return
  const threadId = String(row.thread_id || row.threadId || '').trim()
  const status = String(row.status || '').trim()
  if (isActiveExecTaskStatus(status)) {
    registerPlanExecution(taskId, threadId)
  } else if (isTerminalTaskStatus(status)) {
    unregisterPlanExecution(taskId)
  }
}

/**
 * 批量同步（任务面板 listTasks）；仅更新列表中出现的任务，不因列表缺项而清除 hold。
 * @param {Array<Record<string, unknown>>} tasks
 */
export function syncPlanExecHoldFromTaskList(tasks) {
  if (!Array.isArray(tasks)) return
  for (const row of tasks) {
    syncPlanExecHoldFromTaskRow(row)
  }
}

export function isPlanExecutionHoldActive() {
  return _active.size > 0
}

export function getPlanExecutionHoldSnapshot() {
  let oldestSince = null
  for (const entry of _active.values()) {
    if (oldestSince == null || entry.since < oldestSince) {
      oldestSince = entry.since
    }
  }
  return {
    count: _active.size,
    taskIds: [..._active.keys()],
    oldestSince,
  }
}
