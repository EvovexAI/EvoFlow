/**
 * 子任务列表展示：仅以 GET /tasks → tasks[0].subtasks 为准（见 SessionSidebar）。
 */

import { fetchTaskRowBySessionKey, fetchTaskRowByThread } from './plan-from-api.js'
import { tasksAPI } from './api-client.js'
import { isPendingSubtaskKey } from './collab-sidebar-from-tools.js'
import { extractSubtaskDependsOn } from './collab-subtask-dag.js'

/**
 * @param {unknown} row
 * @param {string} parentTaskId
 * @returns {import('../react/chat-types.js').CollabSubtaskSnapshot | null}
 */
export function mapApiSubtaskRow(row, parentTaskId) {
  if (!row || typeof row !== 'object') return null
  const r = /** @type {Record<string, unknown>} */ (row)
  const sid = String(r.subtaskId || r.subtask_id || r.id || '').trim()
  if (!sid) return null
  const tid = String(parentTaskId || r.parentTaskId || r.task_id || '').trim()
  const wp = r.worker_profile || r.workerProfile
  let assignedFromWp = ''
  if (wp && typeof wp === 'object') {
    const w = /** @type {Record<string, unknown>} */ (wp)
    assignedFromWp = String(
      w.subagent_type || w.subagentType || w.executor_subagent_type || w.agent_code || '',
    ).trim()
  }
  const assignedAgent = String(
    r.assignedAgent ||
      r.assigned_to ||
      r.assignedTo ||
      assignedFromWp ||
      '',
  ).trim()
  const assignedAgentDisplay = String(
    r.assignedAgentDisplay ||
      r.assignedAgentName ||
      r.assigned_agent_name ||
      '',
  ).trim()
  const ref = String(r.ref || '').trim()
  const dependsOn = extractSubtaskDependsOn(r)
  /** @type {import('../react/chat-types.js').CollabSubtaskSnapshot} */
  const out = {
    subtaskId: sid,
    ...(tid ? { parentTaskId: tid } : {}),
    ...(ref ? { ref } : {}),
    ...(dependsOn.length ? { dependsOn } : {}),
    ...(typeof r.name === 'string' && r.name.trim() ? { name: r.name.trim() } : {}),
    ...(typeof r.description === 'string' && r.description.trim()
      ? { description: r.description.trim() }
      : {}),
    ...(typeof r.status === 'string' ? { status: r.status } : {}),
    ...(typeof r.progress === 'number' ? { progress: r.progress } : {}),
    ...(assignedAgent ? { assignedAgent } : {}),
    ...(assignedAgentDisplay ? { assignedAgentDisplay } : {}),
    ...(typeof r.taskReport === 'string'
      ? { taskReport: r.taskReport }
      : typeof r.task_report === 'string'
        ? { taskReport: r.task_report }
        : {}),
    ...(typeof r.currentStep === 'string'
      ? { currentStep: r.currentStep }
      : typeof r.current_step === 'string'
        ? { currentStep: r.current_step }
        : {}),
    ...(Array.isArray(r.observedToolCalls)
      ? { observedToolCalls: r.observedToolCalls }
      : Array.isArray(r.observed_tool_calls)
        ? { observedToolCalls: r.observed_tool_calls }
        : {}),
    ...(r.result != null
      ? {
          result:
            typeof r.result === 'string'
              ? r.result
              : (() => {
                  try {
                    return JSON.stringify(r.result)
                  } catch {
                    return String(r.result)
                  }
                })(),
        }
      : {}),
  }
  return out
}

/**
 * @param {unknown} taskOrList
 * @returns {unknown[]}
 */
export function extractSubtaskRowsFromTaskResponse(taskOrList) {
  if (Array.isArray(taskOrList)) return taskOrList
  if (!taskOrList || typeof taskOrList !== 'object') return []
  const o = /** @type {Record<string, unknown>} */ (taskOrList)
  if (Array.isArray(o.subtasks)) return o.subtasks
  const data = o.data
  if (data && typeof data === 'object' && Array.isArray(/** @type {Record<string, unknown>} */ (data).subtasks)) {
    return /** @type {Record<string, unknown>} */ (data).subtasks
  }
  return []
}

/** 已落库子任务 id（非 plan 流式占位 ``__plan__:…``） */
export function isPersistedCollabSubtaskId(subtaskId) {
  const s = String(subtaskId || '').trim()
  if (!s || isPendingSubtaskKey(s)) return false
  return s.startsWith('Subtask_')
}

/**
 * 展示/写入侧栏子任务列表：一旦存在落库 id，丢弃 plan 占位行，避免与 API ``subtasks`` 重复。
 * @param {import('../react/chat-types.js').CollabSubtaskSnapshot[]} list
 */
export function preferPersistedCollabSubtasks(list) {
  if (!Array.isArray(list) || !list.length) return []
  const persisted = list.filter((s) => isPersistedCollabSubtaskId(s?.subtaskId))
  if (persisted.length) return persisted
  return list
}

function mapSubtaskRows(rows, taskId) {
  return rows
    .map((r) => mapApiSubtaskRow(r, taskId))
    .filter((x) => x && String(x.subtaskId || '').trim())
}

/** sessionKey（agent:main:…）不是 LangGraph thread_id，勿传给 GET /tasks?thread_id= */
function normalizeThreadIdForTasksApi(threadId) {
  const s = String(threadId || '').trim()
  if (!s || s.startsWith('agent:')) return ''
  return s
}

/**
 * @param {unknown} row
 * @returns {import('../react/chat-types.js').CollabTaskSnapshot | null}
 */
export function mapApiMainTaskRow(row) {
  if (!row || typeof row !== 'object') return null
  const r = /** @type {Record<string, unknown>} */ (row)
  const taskId = String(r.id || r.taskId || r.task_id || '').trim()
  if (!taskId) return null
  /** @type {import('../react/chat-types.js').CollabTaskSnapshot} */
  const out = {
    taskId,
    ...(typeof r.name === 'string' && r.name.trim() ? { name: r.name.trim() } : {}),
    ...(typeof r.status === 'string' ? { status: r.status } : {}),
    ...(typeof r.progress === 'number' && !Number.isNaN(r.progress) ? { progress: r.progress } : {}),
    ...(typeof r.execution_authorized === 'boolean'
      ? { executionAuthorized: r.execution_authorized }
      : typeof r.executionAuthorized === 'boolean'
        ? { executionAuthorized: r.executionAuthorized }
        : {}),
    ...(typeof r.lifecycleStage === 'string'
      ? { lifecycleStage: r.lifecycleStage }
      : typeof r.lifecycle_stage === 'string'
        ? { lifecycleStage: r.lifecycle_stage }
        : {}),
    ...(typeof r.lifecycleLabel === 'string'
      ? { lifecycleLabel: r.lifecycleLabel }
      : typeof r.lifecycle_label === 'string'
        ? { lifecycleLabel: r.lifecycle_label }
        : {}),
    ...(typeof r.plan_goal === 'string'
      ? { boundPlanPreview: r.plan_goal.slice(0, 480) }
      : typeof r.planGoal === 'string'
        ? { boundPlanPreview: r.planGoal.slice(0, 480) }
        : {}),
  }
  return out
}

async function fetchCollabTaskRow(taskId = '', options = {}) {
  const threadId = normalizeThreadIdForTasksApi(options.threadId)
  const sessionKey = String(options.sessionKey || '').trim()
  const preferTaskId = String(options.preferTaskId || taskId || '').trim()

  if (preferTaskId) {
    try {
      const direct = await tasksAPI.getTask(preferTaskId)
      if (direct && typeof direct === 'object') return direct
    } catch {
      /* fall through to session/thread lookup */
    }
  }

  if (sessionKey) {
    const bySession = await fetchTaskRowBySessionKey(sessionKey, {
      preferTaskId,
      bypassCache: options.bypassCache,
    })
    if (bySession) return bySession
  }

  if (threadId) {
    const byThread = await fetchTaskRowByThread(threadId, {
      preferTaskId,
      bypassCache: options.bypassCache,
    })
    if (byThread) return byThread
  }

  if (preferTaskId) {
    try {
      return await tasksAPI.getTask(preferTaskId)
    } catch {
      return null
    }
  }
  return null
}

/**
 * 工作流面板：单次 GET /tasks 拉主任务 + 子任务（均以存储为准）。
 * @param {string} [taskId]
 * @param {{ threadId?: string, sessionKey?: string, preferTaskId?: string, bypassCache?: boolean }} [options]
 * @returns {Promise<{ mainTask: import('../react/chat-types.js').CollabTaskSnapshot | null, subtasks: import('../react/chat-types.js').CollabSubtaskSnapshot[] }>}
 */
export async function fetchCollabWorkflowFromApi(taskId = '', options = {}) {
  const preferTaskId = String(options.preferTaskId || taskId || '').trim()
  const row = await fetchCollabTaskRow(taskId, options)
  if (!row) return { mainTask: null, subtasks: [] }
  const tid = String(row.id || row.taskId || row.task_id || preferTaskId || '').trim()
  return {
    mainTask: mapApiMainTaskRow(row),
    subtasks: mapSubtaskRows(extractSubtaskRowsFromTaskResponse(row), tid),
  }
}

/**
 * @param {string} [taskId] 主任务 id（preferTaskId）
 * @param {{ threadId?: string, sessionKey?: string, preferTaskId?: string, bypassCache?: boolean }} [options]
 * @returns {Promise<import('../react/chat-types.js').CollabSubtaskSnapshot[]>}
 */
export async function fetchCollabSubtasksForMainTask(taskId = '', options = {}) {
  const bundle = await fetchCollabWorkflowFromApi(taskId, options)
  return bundle.subtasks
}

/** @deprecated 使用 invalidatePlanApiCache */
export { invalidatePlanApiCache as invalidateCollabSubtasksCache } from './plan-from-api.js'
