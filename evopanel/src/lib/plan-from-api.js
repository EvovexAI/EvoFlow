/**
 * 计划正文以会话 session_key 为查询主键（GET /tasks?session_key=…，thread 轮换后仍稳定）。
 * 控制台过滤：`[plan-api]`
 */

import { tasksAPI } from './api-client.js'
import {
  pickRicherStructuredPlanInput,
  planInputFromTaskRow,
  structuredPlanFromTask,
} from './plan-from-task.js'
import {
  isActiveExecTaskStatus,
  isTerminalTaskStatus,
  PLAN_DOCK_TASK_STATUS,
} from './plan-task-status.js'
import { syncPlanExecHoldFromTaskRow } from './gateway-exec-hold.js'

const PREFIX = '[plan-api]'

/** 同 thread+task 并发/短时重复请求合并，避免 plan 条闪烁 */
const _loadInFlight = new Map()
/** @type {Map<string, { at: number, result: Awaited<ReturnType<typeof loadBoundPlanFromApiUncached>> }>} */
const _loadCache = new Map()
const LOAD_CACHE_MS = 60_000

function loadCacheKey(sessionKey, hintTaskId) {
  return `${String(sessionKey || '').trim()}:${String(hintTaskId || '').trim()}`
}

/** 同 thread 并发/短时重复请求合并（plan + 子任务共用） */
const _rowInflight = new Map()
/** @type {Map<string, { at: number, row: Record<string, unknown> | null }>} */
const _rowCache = new Map()
const ROW_CACHE_MS = 4000

function rowCacheKey(threadId, preferTaskId, sessionKey = '') {
  return `${String(sessionKey || '').trim()}:${String(threadId || '').trim()}:${String(preferTaskId || '').trim()}`
}

/** 切换会话时可按 sessionKey 前缀清缓存 */
export function invalidatePlanApiCache(sessionKeyPrefix = '') {
  const prefix = String(sessionKeyPrefix || '').trim()
  if (!prefix) {
    _loadCache.clear()
    _loadInFlight.clear()
    _rowCache.clear()
    _rowInflight.clear()
    return
  }
  for (const key of [..._loadCache.keys()]) {
    if (key.startsWith(`${prefix}:`)) _loadCache.delete(key)
  }
  for (const key of [..._loadInFlight.keys()]) {
    if (key.startsWith(`${prefix}:`)) _loadInFlight.delete(key)
  }
  for (const key of [..._rowCache.keys()]) {
    if (key.startsWith(`${prefix}:`)) _rowCache.delete(key)
  }
  for (const key of [..._rowInflight.keys()]) {
    if (key.startsWith(`${prefix}:`)) _rowInflight.delete(key)
  }
}

function planApiLog(stage, detail) {
  try {
    if (typeof localStorage === 'undefined') return
    if (localStorage.getItem('EVOFLOW_PLAN_TRACE') !== '1') return
  } catch {
    return
  }
   
  console.log(PREFIX, stage, detail ?? '')
}

/**
 * @param {Record<string, unknown>} task
 * @returns {import('../react/components/PlanDetailView.js').StructuredPlanInput | null}
 */
export function structuredPlanFromApiTask(task) {
  const parsed = structuredPlanFromTask(task)
  if (!parsed) return null
  return {
    goal: parsed.goal,
    flowchartMermaid: parsed.flowchartMermaid,
    steps: parsed.steps,
    validation: parsed.validation,
    openQuestions: parsed.openQuestions,
  }
}

/**
 * ``status=planned`` 时兜底：plan_goal 未写全仍可用 name/description 展示计划条。
 * @param {Record<string, unknown> | null | undefined} row
 */
export function planViewFromPlannedTaskRow(row) {
  if (!row || typeof row !== 'object') return null
  const status = String(row.status || '')
    .trim()
    .toLowerCase()
  if (status !== PLAN_DOCK_TASK_STATUS) return null
  const structured = structuredPlanFromApiTask(row)
  if (structured?.goal) return structured
  const goal = String(row.plan_goal || row.planGoal || row.name || '').trim()
  if (!goal) return null
  const desc = String(row.description || '').trim()
  return {
    goal,
    flowchartMermaid: String(row.plan_flowchart_mermaid || row.planFlowchartMermaid || '').trim(),
    steps: desc
      ? [{ ref: '1', shortName: '概览', displayName: desc.length > 160 ? `${desc.slice(0, 157)}…` : desc }]
      : [],
    validation: [],
    openQuestions: String(row.plan_open_questions || row.planOpenQuestions || '无').trim() || '无',
  }
}

/**
 * 按 thread_id 单次 API 查询主任务（含 plan 字段）。
 * @param {string} threadId
 * @param {{ preferTaskId?: string, bypassCache?: boolean }} [options]
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function fetchTaskRowByThread(threadId, options = {}) {
  const want = String(threadId || '').trim()
  if (!want || want.startsWith('agent:')) return null
  const preferTaskId = String(options.preferTaskId || '').trim()
  const cacheKey = rowCacheKey(want, preferTaskId)
  if (!options.bypassCache) {
    const cached = _rowCache.get(cacheKey)
    if (cached && Date.now() - cached.at < ROW_CACHE_MS) {
      planApiLog('row_cache_hit', { threadId: want, cacheKey })
      return cached.row
    }
  }
  const inflight = _rowInflight.get(cacheKey)
  if (inflight) {
    planApiLog('row_inflight_join', { threadId: want, cacheKey, bypassCache: !!options.bypassCache })
    return inflight
  }
  planApiLog('listTasks thread_id', { threadId: want, preferTaskId, bypassCache: !!options.bypassCache })

  const promise = (async () => {
    try {
      const resp = await tasksAPI.listTasks({
        threadId: want,
        ...(preferTaskId ? { preferTaskId } : {}),
      })
      const tasks = resp?.data?.tasks
      const row = Array.isArray(tasks) && tasks.length ? tasks[0] : null
      if (!row || typeof row !== 'object') {
        if (!options.expectEmpty) {
          planApiLog('empty', { threadId: want })
        }
        return null
      }
      planApiLog('hit', {
        threadId: want,
        taskId: String(row.id || row.taskId || row.task_id || ''),
        hasPlan: !!structuredPlanFromTask(row),
        status: String(row.status || ''),
        executionAuthorized: row.execution_authorized === true || row.execution_authorized === 1,
      })
      syncPlanExecHoldFromTaskRow(row)
      return row
    } catch (e) {
      const msg = String((e && e.message) || e)
      if (/not found/i.test(msg) || /404/.test(msg)) {
        planApiLog('empty', { threadId: want, reason: msg })
        return null
      }
      planApiLog('error', { threadId: want, message: msg })
      throw e
    }
  })()

  _rowInflight.set(cacheKey, promise)
  promise
    .then((row) => {
      if (!options.bypassCache && row) {
        _rowCache.set(cacheKey, { at: Date.now(), row })
      }
    })
    .finally(() => {
      _rowInflight.delete(cacheKey)
    })

  return promise
}

/** @deprecated 使用 fetchTaskRowByThread */
export async function findTaskRowForThread(threadId, options = {}) {
  return fetchTaskRowByThread(threadId, options)
}

/**
 * 按 session_key 单次 API 查询主任务（thread 轮换后仍可用）。
 * @param {string} sessionKey
 * @param {{ preferTaskId?: string, bypassCache?: boolean }} [options]
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function fetchTaskRowBySessionKey(sessionKey, options = {}) {
  const want = String(sessionKey || '').trim()
  if (!want || !want.startsWith('agent:')) return null
  const preferTaskId = String(options.preferTaskId || '').trim()
  const cacheKey = rowCacheKey('', preferTaskId, want)
  if (!options.bypassCache) {
    const cached = _rowCache.get(cacheKey)
    if (cached && Date.now() - cached.at < ROW_CACHE_MS) {
      planApiLog('row_cache_hit', { sessionKey: want, cacheKey })
      return cached.row
    }
  }
  const inflight = _rowInflight.get(cacheKey)
  if (inflight) {
    planApiLog('row_inflight_join', { sessionKey: want, cacheKey, bypassCache: !!options.bypassCache })
    return inflight
  }
  planApiLog('listTasks session_key', { sessionKey: want, preferTaskId, bypassCache: !!options.bypassCache })

  const promise = (async () => {
    try {
      const resp = await tasksAPI.listTasks({
        sessionKey: want,
        ...(preferTaskId ? { preferTaskId } : {}),
      })
      const tasks = resp?.data?.tasks
      const row = Array.isArray(tasks) && tasks.length ? tasks[0] : null
      if (!row || typeof row !== 'object') {
        if (!options.expectEmpty) {
          planApiLog('empty', { sessionKey: want })
        }
        return null
      }
      planApiLog('hit', {
        sessionKey: want,
        taskId: String(row.id || row.taskId || row.task_id || ''),
        hasPlan: !!structuredPlanFromTask(row),
        status: String(row.status || ''),
        executionAuthorized: row.execution_authorized === true || row.execution_authorized === 1,
      })
      syncPlanExecHoldFromTaskRow(row)
      return row
    } catch (e) {
      const msg = String((e && e.message) || e)
      if (/not found/i.test(msg) || /404/.test(msg)) {
        planApiLog('empty', { sessionKey: want, reason: msg })
        return null
      }
      planApiLog('error', { sessionKey: want, message: msg })
      throw e
    }
  })()

  _rowInflight.set(cacheKey, promise)
  promise
    .then((row) => {
      if (!options.bypassCache && row) {
        _rowCache.set(cacheKey, { at: Date.now(), row })
      }
    })
    .finally(() => {
      _rowInflight.delete(cacheKey)
    })

  return promise
}

/** @deprecated 使用 fetchTaskRowByThread */
export async function fetchTaskRowForPlanDock(threadId, options = {}) {
  return fetchTaskRowByThread(threadId, options)
}

/**
 * @param {Record<string, unknown>} row
 * @returns {import('../react/components/PlanDetailView.js').StructuredPlanInput | null}
 */
function structuredPlanFromTaskRow(row) {
  if (!row || typeof row !== 'object') return null
  let apiPlan = structuredPlanFromApiTask(row)
  if (!apiPlan) apiPlan = planViewFromPlannedTaskRow(row)
  if (!apiPlan) {
    const inp = planInputFromTaskRow(row)
    if (inp?.goal) {
      apiPlan = {
        goal: String(inp.goal),
        flowchartMermaid: String(inp.flowchartMermaid || ''),
        steps: inp.steps || [],
        validation: inp.validation || [],
        openQuestions: String(inp.openQuestions || '无'),
      }
    }
  }
  return apiPlan
}

/**
 * 计划 dock / 正文：仅按 session_key（+ task_id 兜底）查主任务，不用 thread_id。
 * @param {{ sessionKey?: string, hintTaskId?: string, bypassCache?: boolean }} input
 */
async function resolveTaskRowForPlanDock(input = {}) {
  const sessionKey = String(input.sessionKey || '').trim()
  const hintTaskId = String(input.hintTaskId || '').trim()
  const bypassCache = !!input.bypassCache

  if (sessionKey) {
    const bySession = await fetchTaskRowBySessionKey(sessionKey, {
      preferTaskId: hintTaskId,
      bypassCache,
    })
    if (bySession) {
      planApiLog('hit_session_key', {
        sessionKey,
        taskId: String(bySession.id || bySession.taskId || bySession.task_id || ''),
        status: String(bySession.status || ''),
      })
      return bySession
    }
  }

  if (hintTaskId) {
    try {
      const byId = await tasksAPI.getTask(hintTaskId)
      if (byId && typeof byId === 'object') {
        syncPlanExecHoldFromTaskRow(byId)
        planApiLog('hit_task_id_fallback', {
          taskId: hintTaskId,
          status: String(byId.status || ''),
        })
        return byId
      }
    } catch (e) {
      planApiLog('task_id_fallback_miss', {
        taskId: hintTaskId,
        message: String((e && e.message) || e),
      })
    }
  }

  return null
}

/**
 * @param {{ threadId?: string, sessionKey?: string, hintTaskId?: string, fallback?: import('../react/components/PlanDetailView.js').StructuredPlanInput | null }} input
 * @returns {Promise<{ plan: import('../react/components/PlanDetailView.js').StructuredPlanInput | null, taskId: string, taskStatus?: string, executionAuthorized?: boolean }>}
 */
async function loadBoundPlanFromApiUncached(input = {}, options = {}) {
  const sessionKey = String(input.sessionKey || '').trim()
  const hintTaskId = String(input.hintTaskId || input.taskId || '').trim()
  const fallback = input.fallback ?? null

  if (!sessionKey && !hintTaskId) {
    planApiLog('skip', 'no sessionKey/hintTaskId')
    const planOnly = fallback ? planViewFromFallback(fallback) : null
    return { plan: planOnly, taskId: hintTaskId }
  }

  let apiPlan = null
  let resolvedTaskId = ''
  /** @type {string} */
  let taskStatus = ''
  let executionAuthorized = false
  /** @type {Record<string, unknown> | null} */
  let taskRow = null

  try {
    const row = await resolveTaskRowForPlanDock({
      sessionKey,
      hintTaskId,
      bypassCache: !!options.bypassCache,
    })
    if (row) {
      taskRow = row
      resolvedTaskId = String(row.id || row.taskId || row.task_id || hintTaskId || '').trim()
      taskStatus = String(row.status || '').trim().toLowerCase()
      executionAuthorized = row.execution_authorized === true || row.execution_authorized === 1
      apiPlan = structuredPlanFromTaskRow(row)
    }
  } catch (e) {
    planApiLog('error', { sessionKey, message: String((e && e.message) || e) })
  }

  if (apiPlan && fallback) {
    const merged = pickRicherStructuredPlanInput(
      {
        goal: apiPlan.goal,
        flowchartMermaid: apiPlan.flowchartMermaid,
        steps: apiPlan.steps,
        validation: apiPlan.validation,
        openQuestions: apiPlan.openQuestions,
      },
      {
        goal: fallback.goal,
        flowchartMermaid: fallback.flowchartMermaid,
        steps: fallback.steps,
        validation: fallback.validation,
        openQuestions: fallback.openQuestions,
      },
    )
    if (merged) {
      apiPlan = {
        goal: String(merged.goal || apiPlan.goal),
        flowchartMermaid: String(merged.flowchartMermaid || apiPlan.flowchartMermaid || ''),
        steps: merged.steps || apiPlan.steps,
        validation: merged.validation || apiPlan.validation,
        openQuestions: String(merged.openQuestions || apiPlan.openQuestions),
      }
    }
  }

  const plan = apiPlan || planViewFromFallback(fallback)
  return {
    plan,
    taskId: resolvedTaskId || hintTaskId,
    taskStatus,
    executionAuthorized,
    taskRow,
  }
}

/**
 * @param {{ threadId?: string, sessionKey?: string, hintTaskId?: string, fallback?: import('../react/components/PlanDetailView.js').StructuredPlanInput | null }} input
 * @returns {Promise<{ plan: import('../react/components/PlanDetailView.js').StructuredPlanInput | null, taskId: string, taskStatus?: string, executionAuthorized?: boolean }>}
 */
export async function loadBoundPlanFromApi(input = {}, options = {}) {
  const sessionKey = String(input.sessionKey || '').trim()
  const hintTaskId = String(input.hintTaskId || input.taskId || '').trim()
  if (!sessionKey) {
    return loadBoundPlanFromApiUncached(input, options)
  }
  const key = loadCacheKey(sessionKey, hintTaskId)
  if (!options.bypassCache) {
    const cached = _loadCache.get(key)
    if (cached && Date.now() - cached.at < LOAD_CACHE_MS) {
      planApiLog('cache_hit', { key })
      return cached.result
    }
  }
  const inflight = _loadInFlight.get(key)
  if (inflight) {
    planApiLog('inflight_join', { key, bypassCache: !!options.bypassCache })
    return inflight
  }
  const promise = loadBoundPlanFromApiUncached(input, options)
    .then((result) => {
      const tid = String(result?.taskId || '').trim()
      if (tid || result?.plan?.goal) {
        _loadCache.set(key, { at: Date.now(), result })
      }
      _loadInFlight.delete(key)
      return result
    })
    .catch((e) => {
      _loadInFlight.delete(key)
      throw e
    })
  _loadInFlight.set(key, promise)
  return promise
}

/**
 * @param {import('../react/components/PlanDetailView.js').StructuredPlanInput | Record<string, unknown> | null} fallback
 */
function planViewFromFallback(fallback) {
  if (!fallback || typeof fallback !== 'object') return null
  return structuredPlanFromApiTask({
    plan_goal: fallback.goal,
    plan_steps: fallback.steps,
    plan_flowchart_mermaid: fallback.flowchartMermaid,
    plan_validation: fallback.validation,
    plan_open_questions: fallback.openQuestions,
  })
}

/**
 * 流式回复结束后：以 GET /tasks?session_key=… 为真源同步计划条展示态。
 * @param {{ sessionKey?: string, hintTaskId?: string, fallback?: import('../react/components/PlanDetailView.js').StructuredPlanInput | null }} input
 * @returns {Promise<{
 *   plan: import('../react/components/PlanDetailView.js').StructuredPlanInput | null
 *   taskId: string
 *   taskStatus: string
 *   executionAuthorized: boolean
 *   showPlanDock: boolean
 *   pastPlanGate: boolean
 * }>}
 */
export async function syncPlanDockStateFromApi(input = {}, options = {}) {
  const sessionKey = String(input.sessionKey || '').trim()
  const empty = {
    plan: null,
    taskId: String(input.hintTaskId || input.taskId || '').trim(),
    taskStatus: '',
    executionAuthorized: false,
    showPlanDock: false,
    pastPlanGate: false,
  }
  if (!sessionKey) {
    planApiLog('sync_skip', 'no sessionKey')
    return empty
  }
  if (options.bypassCache) {
    invalidatePlanApiCache(sessionKey)
  }
  const result = await loadBoundPlanFromApi(input, {
    bypassCache: !!options.bypassCache,
  })
  const taskStatus = String(result.taskStatus || '').trim().toLowerCase()
  const executionAuthorized = !!result.executionAuthorized
  const pastPlanGate =
    executionAuthorized || isActiveExecTaskStatus(taskStatus) || isTerminalTaskStatus(taskStatus)
  // plan 工具报错 / 多次调用（先失败后成功）时，任务状态可能停在 planning 或未及时推进到 planned，
  // 但消息历史 / 流式 latch 中已有 plan 入参（fallback）。此时容错为 planned，让用户能看到 AI 已生成的计划内容。
  const hasPlanContent = !!result.plan
  const needsStatusFallback =
    hasPlanContent && (taskStatus === 'planning' || !taskStatus) && !pastPlanGate
  const effectiveTaskStatus = needsStatusFallback ? PLAN_DOCK_TASK_STATUS : taskStatus
  const showPlanDock = effectiveTaskStatus === PLAN_DOCK_TASK_STATUS && !executionAuthorized
  if (result.taskId || result.plan || effectiveTaskStatus) {
    planApiLog('sync', {
      sessionKey,
      taskId: result.taskId,
      taskStatus: effectiveTaskStatus,
      rawTaskStatus: taskStatus || undefined,
      hasPlan: !!result.plan,
      showPlanDock,
      pastPlanGate,
    })
  }
  return {
    plan: result.plan,
    taskId: String(result.taskId || empty.taskId || '').trim(),
    taskStatus: effectiveTaskStatus,
    executionAuthorized,
    showPlanDock,
    pastPlanGate,
    taskRow: result.taskRow ?? null,
  }
}

/** @deprecated 使用 loadBoundPlanFromApi({ sessionKey, hintTaskId }) */
export async function resolveStructuredPlanForTask(_taskId, options = {}) {
  const { plan } = await loadBoundPlanFromApi({
    sessionKey: options.sessionKey,
    hintTaskId: _taskId,
    fallback: options.fallback ?? null,
  })
  return plan
}
