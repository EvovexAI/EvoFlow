/**
 * Employee info-rail 「当前任务」：一会话可关联多个任务。
 * 默认聚焦最近活跃；用户可手动点选；create 的新任务（更新更晚）会自然成为当前。
 */

import { parseProactiveSessionKey } from './session-list/workspace-groups.js'

export type EmployeeBoardTask = {
  task_id?: string
  id?: string
  name?: string
  description?: string
  plan_goal?: string
  status?: string
  status_zh?: string
  progress?: number | string
  is_subtask?: boolean
  subtask_id?: string
  result?: string
  summary?: string
  source?: string
  source_zh?: string
  source_channel?: string
  source_ref?: string | null
  assigned_to?: string
  assigned_to_zh?: string
  assigned_role?: string
  raised_by?: string
  raised_by_zh?: string
  risk_level?: string
  risk_level_zh?: string
  action_type?: string
  updated_at?: string
  created_at?: string
  started_at?: string
  completed_at?: string
  round_id?: string
  parent_task_id?: string | null
}

const SOURCE_ZH: Record<string, string> = {
  chat: '主对话',
  workflow: '工作流',
  role: '岗位',
  proactive_patrol: '值班巡检',
  proactive_dispatch: '岗位派发',
  proactive: '岗位',
  agent: '智能体岗位',
  '智能体岗位': '智能体岗位',
}

const RISK_ZH: Record<string, string> = {
  low: '低风险',
  medium: '中风险',
  med: '中风险',
  high: '高风险',
  critical: '严重',
}

/** 已知内置 code → 展示名兜底（roles/agents 未加载时仍不露英文 code）。 */
const BUILTIN_AGENT_ZH: Record<string, string> = {
  xiaomi: '小V',
  main: '主对话',
  lead_agent: '主对话',
  executor: '执行器',
}

export function boardTaskId(t: EmployeeBoardTask | null | undefined): string {
  return String(t?.task_id || t?.id || '').trim()
}

export function isRootBoardTask(t: EmployeeBoardTask | null | undefined): boolean {
  return Boolean(t && !t.is_subtask && !t.subtask_id)
}

export function taskSourceLabel(raw: string | undefined | null): string {
  const s = String(raw || '').trim()
  if (!s) return ''
  return SOURCE_ZH[s] || SOURCE_ZH[s.toLowerCase()] || s
}

export function riskLevelLabelZh(raw: string | undefined | null): string {
  const s = String(raw || '').trim()
  if (!s) return ''
  return RISK_ZH[s.toLowerCase()] || s
}

/**
 * agent_code → 中文展示名。优先用调用方传入的 resolver（roles/agents SoT），
 * 再回落内置表；仍没有则原样返回（避免空白）。
 */
export function agentCodeLabelZh(
  code: string | undefined | null,
  resolve?: (code: string) => string,
): string {
  const c = String(code || '').trim()
  if (!c) return ''
  const fromResolver = String(resolve?.(c) || '').trim()
  if (fromResolver && fromResolver.toLowerCase() !== c.toLowerCase()) return fromResolver
  const builtin = BUILTIN_AGENT_ZH[c.toLowerCase()]
  if (builtin) return builtin
  return fromResolver || c
}

/** 看板行若仍是 pending，但会话正在跑 / 岗位正忙本会话 → 按执行中展示。 */
export function effectiveBoardTaskStatus(
  raw: string | undefined | null,
  opts: { isRunning?: boolean; roleBusyOnSession?: boolean } = {},
): string {
  const s = normalizeTaskStatusKey(raw)
  if (isTerminalTaskStatus(s)) return s || 'completed'
  if (opts.isRunning || opts.roleBusyOnSession) {
    if (
      !s ||
      s === 'pending' ||
      s === 'proposed' ||
      s === 'todo' ||
      s === 'planned' ||
      s === 'planning' ||
      s === 'idle' ||
      s === 'queued'
    ) {
      return 'executing'
    }
  }
  return s || (opts.isRunning ? 'executing' : 'pending')
}

export function normalizeTaskStatusKey(raw: string | undefined | null): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
}

export function isActiveTaskStatus(raw: string | undefined | null): boolean {
  const s = normalizeTaskStatusKey(raw)
  return (
    s === 'executing' ||
    s === 'in_progress' ||
    s === 'running' ||
    s === 'active' ||
    s === 'pending' ||
    s === 'planned' ||
    s === 'planning' ||
    s === 'waiting_user' ||
    s === 'pending_approval' ||
    s === 'req_confirm' ||
    s === 'paused'
  )
}

export function isTerminalTaskStatus(raw: string | undefined | null): boolean {
  const s = normalizeTaskStatusKey(raw)
  return (
    s === 'completed' ||
    s === 'done' ||
    s === 'success' ||
    s === 'reviewed' ||
    s === 'failed' ||
    s === 'error' ||
    s === 'timed_out' ||
    s === 'cancelled' ||
    s === 'canceled' ||
    s === 'rejected'
  )
}

function activityStamp(t: EmployeeBoardTask): string {
  return String(t.updated_at || t.created_at || '')
}

function sortByActivityDesc(a: EmployeeBoardTask, b: EmployeeBoardTask): number {
  return activityStamp(b).localeCompare(activityStamp(a))
}

/**
 * Tasks tied to this conversation: source_ref=session_key, or hint ids
 * (legacy :task: key / live focus). Falls back to open role tasks when none match.
 */
export function listSessionBoardTasks(
  tasks: EmployeeBoardTask[],
  sessionKey: string,
  hintIds: string[] = [],
  limit = 10,
): { items: EmployeeBoardTask[]; scoped: boolean } {
  const roots = (Array.isArray(tasks) ? tasks : []).filter(isRootBoardTask)
  const sk = String(sessionKey || '').trim()
  const hints = new Set(
    (Array.isArray(hintIds) ? hintIds : [])
      .map((x) => String(x || '').trim())
      .filter(Boolean),
  )
  const related = roots.filter((t) => {
    const id = boardTaskId(t)
    if (id && hints.has(id)) return true
    const ref = String(t.source_ref || '').trim()
    return Boolean(sk && ref && ref === sk)
  })
  const scoped = related.length > 0
  const pool = scoped
    ? related
    : roots.filter((t) => {
        const id = boardTaskId(t)
        return !isTerminalTaskStatus(t.status) || (id && hints.has(id))
      })
  const items = [...pool].sort((a, b) => {
    const aActive = isActiveTaskStatus(a.status) ? 1 : 0
    const bActive = isActiveTaskStatus(b.status) ? 1 : 0
    if (aActive !== bActive) return bActive - aActive
    return sortByActivityDesc(a, b)
  })
  return { items: items.slice(0, Math.max(0, limit)), scoped }
}

/** 摘要任务 Tab：进行中 / 待办 / 已处理。 */
export function groupBoardTasksByLane(tasks: EmployeeBoardTask[]): {
  active: EmployeeBoardTask[]
  queued: EmployeeBoardTask[]
  /** @deprecated 兼容旧调用：active+queued */
  open: EmployeeBoardTask[]
  done: EmployeeBoardTask[]
} {
  const active: EmployeeBoardTask[] = []
  const queued: EmployeeBoardTask[] = []
  const done: EmployeeBoardTask[] = []
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (isTerminalTaskStatus(t.status)) {
      done.push(t)
      continue
    }
    const s = normalizeTaskStatusKey(t.status)
    if (
      s === 'executing' ||
      s === 'in_progress' ||
      s === 'running' ||
      s === 'active' ||
      s === 'paused' ||
      s === 'waiting_user' ||
      s === 'pending_approval' ||
      s === 'req_confirm'
    ) {
      active.push(t)
    } else {
      queued.push(t)
    }
  }
  active.sort(sortByActivityDesc)
  queued.sort(sortByActivityDesc)
  done.sort(sortByActivityDesc)
  return { active, queued, open: [...active, ...queued], done }
}

/**
 * Pick 「当前」任务：手动 focus > 最近活跃 > soft preferred / busy hint > 最近任意。
 * 一会话多任务时，新建/推进的任务因 updated_at 更新会成为当前。
 */
export function pickBoardTask(
  tasks: EmployeeBoardTask[],
  preferredId: string,
  busySessionKey: string,
  focusId = '',
): EmployeeBoardTask | null {
  const list = (Array.isArray(tasks) ? tasks : []).filter(isRootBoardTask)
  if (!list.length) return null

  const focus = String(focusId || '').trim()
  if (focus) {
    const hit = list.find((t) => boardTaskId(t) === focus)
    if (hit) return hit
  }

  const actives = list.filter((t) => isActiveTaskStatus(t.status)).sort(sortByActivityDesc)
  if (actives.length) return actives[0]

  const pref = String(preferredId || '').trim()
  if (pref) {
    const hit = list.find((t) => boardTaskId(t) === pref)
    if (hit) return hit
  }

  const fromBusy = String(busySessionKey || '').trim()
  if (fromBusy) {
    const parsed = parseProactiveSessionKey(fromBusy)
    if (parsed.taskId) {
      const hit = list.find((t) => boardTaskId(t) === parsed.taskId)
      if (hit) return hit
    }
  }

  return [...list].sort(sortByActivityDesc)[0] || null
}

/** liveTask overlays progress when it matches the focused board task. */
export function resolveOverlayLiveTask<T extends { taskId?: string | null }>(
  focusTaskId: string,
  liveTask: T | null | undefined,
): T | null {
  if (!liveTask) return null
  const focus = String(focusTaskId || '').trim()
  const liveId = String(liveTask.taskId || '').trim()
  if (focus && liveId && liveId !== focus) return null
  return liveTask
}
