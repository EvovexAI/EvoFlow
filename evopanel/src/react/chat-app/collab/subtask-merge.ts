/**
 * Collab subtask list merge / stabilize helpers.
 * Extracted from ChatApp.tsx module-top helpers (P0).
 */
import { preferPersistedCollabSubtasks } from '../../../lib/collab-subtasks-from-api.js'
import { stabilizeCollabSubtasksByStreamPhase as stabilizeCollabSubtasksByStreamPhaseLib } from '../../../lib/collab-subtask-stream-status.js'
import type {
  CollabSubtaskSnapshot,
  CollabTaskSnapshot,
  SubagentStreamTask,
  SupervisorStepSnapshot,
} from '../../chat-types.js'

export function parseParentAndSubtaskIdFromComposite(
  taskId: string,
): { parentTaskId: string; subtaskId: string } | null {
  const raw = String(taskId || '').trim()
  if (!raw) return null
  const parts = raw.split('-').filter(Boolean)
  if (parts.length < 3) return null
  const a = parts[parts.length - 3] || ''
  const b = parts[parts.length - 2] || ''
  if (!/^[a-f0-9]{8}$/i.test(a) || !/^[a-f0-9]{8}$/i.test(b)) return null
  return { parentTaskId: a.toLowerCase(), subtaskId: b.toLowerCase() }
}

/** 子智能体流事件 → 协作子任务 status */
export function collabStatusFromSubagentStreamEv(ev: Record<string, unknown>): string | null {
  const t = ev.type
  if (t === 'task_started' || t === 'task_running') return 'executing'
  if (t === 'task_completed') return 'completed'
  if (t === 'task_failed') return 'failed'
  if (t === 'task_timed_out') return 'timed_out'
  return null
}

export function patchCollabSubtasksById(
  list: CollabSubtaskSnapshot[],
  subtaskId: string,
  status: string,
  patch?: Partial<CollabSubtaskSnapshot>,
): CollabSubtaskSnapshot[] {
  const normalizeStatus = (v?: string) =>
    String(v || '')
      .trim()
      .toLowerCase()
      .replace(/-/g, '_')
  const isTerminal = (v?: string) => {
    const s = normalizeStatus(v)
    return s === 'completed' || s === 'failed' || s === 'cancelled' || s === 'timed_out'
  }
  const statusRank = (v?: string) => {
    const s = normalizeStatus(v)
    if (s === 'completed') return 4
    if (s === 'failed') return 3
    if (s === 'cancelled' || s === 'timed_out') return 2
    if (s === 'in_progress' || s === 'running' || s === 'executing') return 1
    return 0
  }
  const nextStatusNorm = normalizeStatus(status)
  const nextIsTerminal = isTerminal(nextStatusNorm)
  let changed = false
  const next = list.map((s) => {
    if (s.subtaskId !== subtaskId) return s
    if (isTerminal(s.status) && !nextIsTerminal) return s
    if (normalizeStatus(s.status) === 'completed' && nextStatusNorm !== 'completed') return s
    if (statusRank(s.status) > statusRank(nextStatusNorm)) return s
    changed = true
    return { ...s, status, ...(status === 'completed' ? { progress: 100 } : {}), ...(patch || {}) }
  })
  return changed ? next : list
}

export function mergeCollabSubtasksStable(
  prevList: CollabSubtaskSnapshot[],
  incomingList: CollabSubtaskSnapshot[],
): CollabSubtaskSnapshot[] {
  const normalizeStatus = (v?: string) =>
    String(v || '')
      .trim()
      .toLowerCase()
      .replace(/-/g, '_')
  const statusRank = (v?: string) => {
    const s = normalizeStatus(v)
    if (s === 'completed') return 4
    if (s === 'failed') return 3
    if (s === 'cancelled' || s === 'timed_out') return 2
    if (s === 'in_progress' || s === 'running' || s === 'executing' || s === 'active') return 1
    return 0
  }

  const nextById = new Map<string, CollabSubtaskSnapshot>()
  for (const row of prevList || []) {
    const id = String(row?.subtaskId || '').trim()
    if (!id) continue
    nextById.set(id, row)
  }
  for (const row of incomingList || []) {
    const id = String(row?.subtaskId || '').trim()
    if (!id) continue
    const prev = nextById.get(id)
    if (!prev) {
      nextById.set(id, row)
      continue
    }
    const prevStatus = String(prev.status || '').trim()
    const inStatus = String(row.status || '').trim()
    const keepPrevStatus = statusRank(prevStatus) > statusRank(inStatus)
    nextById.set(id, {
      ...prev,
      ...row,
      ...(keepPrevStatus ? { status: prevStatus } : {}),
      ...(normalizeStatus(prevStatus) === 'completed' && normalizeStatus(inStatus) !== 'completed'
        ? { status: prevStatus, progress: typeof prev.progress === 'number' ? prev.progress : 100 }
        : {}),
    })
  }
  return Array.from(nextById.values())
}

export function stabilizeCollabSubtasksByStreamPhase(
  list: CollabSubtaskSnapshot[],
  subagentTasks?: Record<string, SubagentStreamTask>,
): CollabSubtaskSnapshot[] {
  return stabilizeCollabSubtasksByStreamPhaseLib(list, subagentTasks)
}

export function finalizeCollabSubtasksList(
  list: CollabSubtaskSnapshot[],
  subagentTasks?: Record<string, SubagentStreamTask>,
): CollabSubtaskSnapshot[] {
  return stabilizeCollabSubtasksByStreamPhase(preferPersistedCollabSubtasks(list), subagentTasks)
}

export function mapSnapSupervisorSteps(raw: unknown): SupervisorStepSnapshot[] {
  if (!Array.isArray(raw)) return []
  return raw.map((x, i) => {
    const r = x as Record<string, unknown>
    return {
      id: String(r.id ?? r.step_id ?? `step-${i}`),
      action: String(r.action ?? ''),
      label: String(r.label ?? r.action ?? '步骤'),
      done: !!(r.done ?? r.completed),
    }
  })
}

export type SidebarTaskView = {
  task: CollabTaskSnapshot
  subtasks: CollabSubtaskSnapshot[]
  steps: SupervisorStepSnapshot[]
  updatedAt: number
  /** 写入侧栏快照时的会话 key，避免切换对话后仍展示其它会话任务 */
  sessionKey?: string
}

export function trimStepsToLatestTask(steps?: SupervisorStepSnapshot[]): SupervisorStepSnapshot[] | undefined {
  if (!steps || !steps.length) return steps
  let start = -1
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    const label = String(s.label || '').toLowerCase()
    const action = String(s.action || '').toLowerCase()
    if (
      label.includes('创建主任务') ||
      label.includes('create task') ||
      action.includes('create_task')
    ) {
      start = i
    }
  }
  if (start <= 0) return steps
  return steps.slice(start)
}
