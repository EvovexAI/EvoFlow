/**
 * 小V数据适配层：聚合现有 Gateway API，不平行造模型
 */
import { api, gatewayProxy } from '../../lib/tauri-api.js'
import { toTaskStatusGroup, normalizeTaskStatusKey, formatTaskStatusZh } from '../../lib/task-status-label.js'
import {
  buildAttentionItems,
  buildSuggestedActions,
  computeBadgeCount,
  mapAgentWorkStatus,
} from './assistant-rules.js'
import { isAttentionRead } from './assistant-store.js'

function tasksFromRes(res) {
  if (Array.isArray(res)) return res
  if (Array.isArray(res?.tasks)) return res.tasks
  if (Array.isArray(res?.data?.tasks)) return res.data.tasks
  return []
}

function approvalsFromRes(res) {
  if (Array.isArray(res)) return res
  if (Array.isArray(res?.approvals)) return res.approvals
  return []
}

function rolesFromRes(res) {
  if (Array.isArray(res)) return res
  if (Array.isArray(res?.roles)) return res.roles
  return []
}

/** 解析任务时间（兼容秒级时间戳 / SQLite 无时区字符串） */
export function parseTaskTime(raw) {
  if (raw == null || raw === '') return null
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const s = String(raw).trim()
  if (!s) return null
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s)
    if (!Number.isFinite(n)) return null
    const ms = n < 1e12 ? n * 1000 : n
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d
  }
  let normalized = s
  if (/^\d{4}-\d{2}-\d{2} /.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    normalized = s.replace(' ', 'T')
  }
  const d = new Date(normalized)
  return Number.isNaN(d.getTime()) ? null : d
}

function isToday(iso) {
  const d = parseTaskTime(iso)
  if (!d) return false
  const n = new Date()
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
}

/**
 * @returns {Promise<{
 *   summary: object,
 *   attentionItems: array,
 *   activeTasks: array,
 *   recentCompletions: array,
 *   suggestedActions: array,
 *   agents: array,
 *   approvals: array,
 *   badgeCount: number,
 *   partialUnavailable: boolean,
 *   error: string,
 * }>}
 */
export async function fetchAssistantDashboard() {
  let partialUnavailable = false
  let error = ''

  const [rolesRes, tasksRes, apprRes, busyMap] = await Promise.all([
    api.proactiveListRoles().catch((e) => {
      partialUnavailable = true
      error = String(e?.message || e)
      return { roles: [] }
    }),
    api.listAllTasks().catch((e) => {
      partialUnavailable = true
      error = String(e?.message || e)
      return { tasks: [] }
    }),
    api.proactiveListApprovals('pending').catch((e) => {
      partialUnavailable = true
      error = String(e?.message || e)
      return { approvals: [] }
    }),
    Promise.resolve(null),
  ])

  const roles = rolesFromRes(rolesRes).filter((r) => String(r.status || '') !== 'archived')
  const tasks = tasksFromRes(tasksRes)
  const approvals = approvalsFromRes(apprRes).filter(
    (a) => String(a.status || '').toLowerCase() === 'pending',
  )

  // Best-effort busy flags (limit concurrency)
  const activeRoles = roles.filter((r) => String(r.status || '') === 'active').slice(0, 12)
  await Promise.all(
    activeRoles.map(async (r) => {
      const code = String(r.agent_code || '').trim()
      if (!code) return
      try {
        const b = await api.proactiveRoleBusy(code)
        r._busy = Boolean(b?.busy || b?.running || b?.is_busy)
      } catch {
        r._busy = false
      }
    }),
  )

  const roleTasks = tasks.filter((t) => String(t.assigned_role || t.assigned_to || '').trim())
  const executing = roleTasks.filter((t) => {
    const g = toTaskStatusGroup(t.status)
    return g === 'executing' || g === 'planning'
  })
  const blocked = roleTasks.filter((t) => {
    const s = normalizeTaskStatusKey(t.status)
    return s === 'blocked' || s === 'failed' || s === 'error' || s === 'timed_out'
  })
  const waitingUser = roleTasks.filter((t) => {
    const s = normalizeTaskStatusKey(t.status)
    return s === 'waiting_user' || s === 'req_confirm'
  })
  const completedToday = roleTasks.filter((t) => {
    const g = toTaskStatusGroup(t.status)
    return g === 'completed' && isToday(t.updated_at || t.completed_at)
  })
  const reviewed = roleTasks.filter((t) => normalizeTaskStatusKey(t.status) === 'reviewed')

  const workingAgents = roles.filter((r) => r._busy || String(r.status || '') === 'active').filter((r) => r._busy)

  const attentionItems = buildAttentionItems(roleTasks, approvals, { limit: 4 })
  const unreadAttention = attentionItems.filter((it) => !isAttentionRead(it.id))

  const badgeCount = computeBadgeCount({
    approvals: approvals.length,
    waitingUser: waitingUser.length,
    blocked: blocked.filter((t) => toTaskStatusGroup(t.status) === 'failed' || normalizeTaskStatusKey(t.status) === 'blocked')
      .length,
    failed: roleTasks.filter((t) => toTaskStatusGroup(t.status) === 'failed').length,
    completedUnread: unreadAttention.filter((a) => a.kind === 'task_completed').length,
  })

  const activeTasks = executing.slice(0, 4).map((t) => ({
    id: t.id || t.task_id,
    name: t.name || t.title,
    owner: t.assigned_role || t.assigned_to,
    status: formatTaskStatusZh(t.status),
    statusRaw: t.status,
    currentStep: t.current_step || t.progress_summary || '',
    progressSummary: t.progress_summary || (t.progress != null ? `${t.progress}%` : ''),
    lastUpdatedAt: t.updated_at || t.created_at,
    agentCode: t.assigned_to,
  }))

  const recentCompletions = [
    ...completedToday,
    ...reviewed.filter((t) => isToday(t.updated_at)),
  ]
    .slice(0, 4)
    .map((t) => ({
      id: t.id || t.task_id,
      name: t.name || t.title,
      owner: t.assigned_role || t.assigned_to,
      completedAt: t.updated_at || t.completed_at,
      status: formatTaskStatusZh(t.status),
    }))

  const agents = roles.map((r) => ({
    agent_code: r.agent_code,
    role_name: r.role_name,
    department: r.department,
    status: r.status,
    workStatus: mapAgentWorkStatus(r.status, Boolean(r._busy)),
    busy: Boolean(r._busy),
    last_heartbeat_at: r.last_heartbeat_at,
    next_heartbeat_at: r.next_heartbeat_at,
    avatar: r.avatar || null,
    avatar_meta: r.avatar_meta || null,
    has_avatar_file: r.has_avatar_file,
    avatar_rev: r.avatar_rev || null,
  }))

  const suggestedActions = buildSuggestedActions(roleTasks, agents, { limit: 3 })

  const xiaomiRole = roles.find((r) => String(r.agent_code || '').trim() === 'xiaomi')
  const feishuBinding = xiaomiRole?.feishu_binding || xiaomiRole?.config?.feishu_binding || {}
  const feishuBound = Boolean(feishuBinding.bound)

  return {
    summary: {
      workingAgents: workingAgents.length,
      activeRoles: roles.filter((r) => String(r.status || '') === 'active').length,
      executingTasks: executing.length,
      blockedTasks: blocked.length,
      pendingApprovals: approvals.length,
      waitingUser: waitingUser.length,
      completedToday: completedToday.length,
      reviewedPending: reviewed.length,
    },
    attentionItems,
    activeTasks,
    recentCompletions,
    suggestedActions,
    agents,
    approvals,
    feishuBound,
    badgeCount: Math.max(
      badgeCount,
      computeBadgeCount({
        approvals: approvals.length,
        waitingUser: waitingUser.length,
        blocked: attentionItems.filter((a) => a.kind === 'task_blocked').length,
        failed: attentionItems.filter((a) => a.kind === 'task_failed').length,
        completedUnread: 0,
      }),
    ),
    partialUnavailable,
    error,
  }
}

/**
 * 从任务列表筛出某员工线程：进行中 + 今日/最近汇报 + 历史（不含工具轨迹）。
 * @param {array} tasks
 * @param {string} agentCode
 * @param {{ roleName?: string }} [opts]
 */
export function buildEmployeeThreadFromTasks(tasks, agentCode, opts = {}) {
  const code = String(agentCode || '').trim()
  const roleName = String(opts.roleName || '').trim()
  if (!code) return { openTasks: [], recentReports: [], historyReports: [], reports: [] }

  const mine = (Array.isArray(tasks) ? tasks : []).filter((t) => {
    const to = String(t.assigned_to || '').trim()
    const ar = String(t.assigned_role || '').trim()
    return to === code || ar === code || (roleName && ar === roleName)
  })

  /** @type {array} */
  const openTasks = []
  /** @type {array} */
  const completed = []

  for (const t of mine) {
    const g = toTaskStatusGroup(t.status)
    const updatedAt = t.updated_at || t.completed_at || t.created_at
    const item = {
      id: t.id || t.task_id,
      name: t.name || t.title || '未命名任务',
      status: formatTaskStatusZh(t.status),
      statusRaw: t.status,
      progress: Math.max(0, Math.min(100, Number(t.progress) || 0)),
      progressSummary: String(t.progress_summary || t.current_step || '').trim(),
      summary: String(t.summary || '').trim(),
      result: String(t.result || t.execution_result || '').trim(),
      updatedAt,
    }
    if (g === 'completed') completed.push(item)
    else if (g === 'cancelled') continue
    else openTasks.push(item)
  }

  const byUpdatedAsc = (a, b) => {
    const ta = parseTaskTime(a.updatedAt)?.getTime() || 0
    const tb = parseTaskTime(b.updatedAt)?.getTime() || 0
    return ta - tb
  }
  // 会话时间线：旧在上、新在下
  openTasks.sort(byUpdatedAsc)
  completed.sort(byUpdatedAsc)

  /** @type {array} */
  let recentReports = completed.filter((t) => isToday(t.updatedAt)).slice(-2)
  const recentIds = new Set(recentReports.map((t) => String(t.id)))
  // 今日没有完成项时，最多露出 1 条最新完成，避免主区空白又不全量铺历史
  if (!recentReports.length && completed.length) {
    recentReports = completed.slice(-1)
    recentIds.add(String(completed[completed.length - 1].id))
  }
  const historyReports = completed.filter((t) => !recentIds.has(String(t.id))).slice(-20)

  return {
    openTasks: openTasks.slice(-12),
    recentReports,
    historyReports,
    /** @deprecated 兼容旧调用方 */
    reports: recentReports,
  }
}

/**
 * 员工「会话」数据：任务进度 + 最终汇报（不拉值班工具 transcript）。
 * @param {string} agentCode
 * @param {{ roleName?: string }} [opts]
 */
export async function fetchEmployeeThread(agentCode, opts = {}) {
  const code = String(agentCode || '').trim()
  if (!code) throw new Error('缺少员工')
  const roleName = String(opts.roleName || '').trim()

  const [tasksRes, busyRes] = await Promise.all([
    api.listAllTasks().catch(() => ({ tasks: [] })),
    api.proactiveRoleBusy(code).catch(() => ({})),
  ])
  const built = buildEmployeeThreadFromTasks(tasksFromRes(tasksRes), code, { roleName })
  const busy = Boolean(busyRes?.busy || busyRes?.running || busyRes?.is_busy)
  return { ...built, busy, code }
}

export async function delegateToEmployee(agentCode, { title, goal, description = '' } = {}) {
  const code = String(agentCode || '').trim()
  if (!code) throw new Error('请选择员工')
  const g = String(goal || title || '').trim()
  if (!g) throw new Error('请填写任务目标')
  return api.proactiveDispatchTask(code, {
    goal: g,
    description: String(description || '').trim(),
    source: 'xiaomi_assistant',
    priority: 'normal',
  })
}

export async function requestEmployeeUpdate(agentCode, taskId = '') {
  const code = String(agentCode || '').trim()
  if (!code) throw new Error('缺少员工')
  const tid = String(taskId || '').trim()
  let roleName = code
  try {
    const { getState } = await import('./assistant-store.js')
    const roles = getState()?.roles || []
    const hit = roles.find((r) => String(r.agent_code || '').toLowerCase() === code.toLowerCase())
    if (hit?.role_name) roleName = String(hit.role_name)
  } catch {
    /* ignore */
  }
  const day = new Date().toISOString().slice(0, 10)
  const goal = tid
    ? `请更新工作项 ${tid} 的进度：用 tasks progress / state 回写证据，必要时说明阻塞。`
    : `进度汇报 · ${roleName} · ${day}\n请汇报当前岗位未结工作项进度，并用 tasks progress 回写。`
  return api.proactiveDispatchTask(code, {
    goal,
    description: tid ? `task_id=${tid}` : 'status_check',
    source: 'status_check',
    priority: 'normal',
  })
}

export { formatTaskStatusZh }


// ── 群聊会议 ──────────────────────────────────────────────

/**
 * 创建群聊会议，默认包含所有在职员工。
 * @param {string[]} participantCodes - 参会员工 agent_code 列表
 * @param {string} title - 会议标题
 * @returns {Promise<{meeting_id: string, participants: array, status: string}>}
 */
export async function createMeeting(participantCodes, title = '群聊会议') {
  const codes = (participantCodes || []).filter((c) => c && c !== 'xiaomi')
  if (!codes.length) throw new Error('没有可参会的员工，请先创建智能体员工')
  return gatewayProxy('POST', '/meetings', {
    title,
    participants: codes,
    session_key: '',
  })
}

/**
 * 获取会议详情。
 * @returns {Promise<{meeting_id: string, title: string, status: string, participants: array}>}
 */
export async function getMeeting(meetingId) {
  return gatewayProxy('GET', `/meetings/${encodeURIComponent(meetingId)}`)
}

/**
 * 发起一轮讨论（后台串行调度，立即返回 turn_id）。
 * @returns {Promise<{meeting_id: string, turn_id: string, topic: string, status: string}>}
 */
export async function startMeetingDiscussion(meetingId, topic, opts = {}) {
  const t = String(topic || '').trim()
  if (!t) throw new Error('请输入讨论话题')
  const body = { topic: t }
  if (opts && opts.allowTools) body.allow_tools = true
  return gatewayProxy('POST', `/meetings/${encodeURIComponent(meetingId)}/discuss`, body)
}

/**
 * 轮询会议中的 A2A 任务结果。
 * @returns {Promise<{meeting_id: string, tasks: array}>}
 */
export async function pollMeetingTasks(meetingId) {
  return gatewayProxy('GET', `/meetings/${encodeURIComponent(meetingId)}/tasks`)
}

/**
 * 轮询会议讨论轮次状态（用于判断当前 turn 是否 completed）。
 * @returns {Promise<{meeting_id: string, turns: array}>}
 */
export async function pollMeetingTurns(meetingId) {
  return gatewayProxy('GET', `/meetings/${encodeURIComponent(meetingId)}/turns`)
}

/**
 * 点名某一参会员工做口头汇报。
 * @param {string} [contextSummary] 可选：前面同事刚说的，供衔接
 * @returns {Promise<{agent_code: string, role_name: string, task: object, reply?: string}>}
 */
export async function mentionMeeting(meetingId, agentCode, text, contextSummary = '', opts = {}) {
  const code = String(agentCode || '').trim()
  const t = String(text || '').trim()
  if (!code) throw new Error('请选择要点名的员工')
  if (!t) throw new Error('请输入想问的内容')
  /** @type {Record<string, string|boolean>} */
  const body = { agent_code: code, text: t }
  const ctx = String(contextSummary || '').trim()
  if (ctx) body.context_summary = ctx
  if (opts && opts.allowTools) body.allow_tools = true
  return gatewayProxy('POST', `/meetings/${encodeURIComponent(meetingId)}/mention`, body)
}

/**
 * 综合本场发言，产出最优方案并沉淀为 Asset Hub 文档。
 * @returns {Promise<{ok: boolean, meeting_id: string, conclusion: object, turn_count: number, asset?: object}>}
 */
export async function concludeMeeting(meetingId, topic = '') {
  const mid = String(meetingId || '').trim()
  if (!mid) throw new Error('缺少会议 ID')
  const body = {}
  const t = String(topic || '').trim()
  if (t) body.topic = t
  return gatewayProxy('POST', `/meetings/${encodeURIComponent(mid)}/conclude`, body)
}
