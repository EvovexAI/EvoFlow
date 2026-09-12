/**
 * Merge API subtask rows with in-memory stream phase (running/completed).
 */

import type { CollabSubtaskSnapshot, SubagentStreamTaskMap } from '../react/chat-types.js'

function normalizeStatus(status?: string): string {
  return String(status || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
}

export function stabilizeCollabSubtasksByStreamPhase(
  list: CollabSubtaskSnapshot[],
  subagentTasks?: SubagentStreamTaskMap,
): CollabSubtaskSnapshot[] {
  const values = Object.values(subagentTasks || {})
  if (!values.length || !Array.isArray(list) || !list.length) return list

  const phaseBySubtaskId = new Map<string, string>()
  for (const t of values) {
    let sid = String(t?.collabSubtaskId || '').trim()
    if (!sid) {
      const tid = String(t?.taskId || '').trim()
      if (/^Subtask_/i.test(tid)) sid = tid
    }
    if (!sid) continue
    const phase = String(t?.phase || '').trim().toLowerCase()
    if (!phase) continue
    phaseBySubtaskId.set(sid, phase)
  }
  if (!phaseBySubtaskId.size) return list

  let changed = false
  const out = list.map((row) => {
    const sid = String(row?.subtaskId || '').trim()
    if (!sid) return row
    const phase = phaseBySubtaskId.get(sid)
    if (!phase) return row
    const cur = normalizeStatus(row?.status)
    if (phase === 'running') {
      if (cur === 'pending' || cur === 'planned' || cur === '' || cur === 'waiting_dispatch') {
        changed = true
        const prog =
          typeof row.progress === 'number' && row.progress > 0
            ? row.progress
            : Math.max(typeof row.progress === 'number' ? row.progress : 0, 5)
        return { ...row, status: 'executing', progress: prog }
      }
      return row
    }
    if (phase === 'completed' && cur !== 'completed' && cur !== 'done') {
      changed = true
      return {
        ...row,
        status: 'completed',
        progress: typeof row.progress === 'number' ? Math.max(100, row.progress) : 100,
      }
    }
    return row
  })
  return changed ? out : list
}

export function mergeCollabSubtaskSnapshots(
  primary: CollabSubtaskSnapshot[],
  overlay?: CollabSubtaskSnapshot[] | null,
): CollabSubtaskSnapshot[] {
  if (!overlay?.length) return primary
  const byId = new Map<string, CollabSubtaskSnapshot>()
  for (const row of primary) {
    const id = String(row?.subtaskId || '').trim()
    if (id) byId.set(id, row)
  }
  for (const row of overlay) {
    const id = String(row?.subtaskId || '').trim()
    if (!id) continue
    const prev = byId.get(id)
    byId.set(id, prev ? { ...prev, ...row } : row)
  }
  return Array.from(byId.values())
}
