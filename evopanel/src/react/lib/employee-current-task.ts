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
  assigned_role?: string
  raised_by?: string
  risk_level?: string
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
