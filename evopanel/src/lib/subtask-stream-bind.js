/**
 * Bind collab subtask sidebar cards to per-subtask SSE stream aggregates (`subagentTasks`).
 * Must not attach a running stream to pending subtasks that share wording with the active one.
 */

import { isPersistedCollabSubtaskId } from './collab-subtasks-from-api.js'
import { sanitizeSubtaskLiveTicker } from './subtask-live-preview.js'

/** @param {import('../react/chat-types.js').SubagentStreamTask[]} pool */
export function matchStreamTaskByDescription(pool, fallbackText) {
  const txt = String(fallbackText || '')
    .trim()
    .toLowerCase()
  if (!txt || !pool.length) return undefined
  const scored = pool
    .map((t) => {
      const d = String(t.description || '')
        .trim()
        .toLowerCase()
      if (!d) return { t, score: 0 }
      let score = 0
      if (txt === d) score += 100
      else if (txt.includes(d) || d.includes(txt)) score += 50
      const ta = txt.split(/[\s·｜|,_-]+/).filter((x) => x.length >= 2)
      for (const w of ta) {
        if (w.length >= 2 && d.includes(w)) score += 8
      }
      return { t, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
  return scored[0]?.t
}

function subtaskIdsEqual(a, b) {
  const left = String(a || '').trim()
  const right = String(b || '').trim()
  if (!left || !right) return false
  if (left === right) return true
  const left8 = left.length > 8 ? left.slice(-8) : left
  const right8 = right.length > 8 ? right.slice(-8) : right
  return left8 === right8
}

function findStreamTaskByCollabSubtaskId(tasksMap, collabSubtaskId) {
  const cid = String(collabSubtaskId || '').trim()
  if (!cid) return undefined
  const direct = tasksMap?.[cid]
  if (direct) return direct
  const all = Object.values(tasksMap || {})
  const byCollab = all.find(
    (t) => subtaskIdsEqual(t.collabSubtaskId, cid) || subtaskIdsEqual(t.taskId, cid),
  )
  if (byCollab) return byCollab
  const cidTail = cid.length > 8 ? cid.slice(-8) : cid
  return all.find((t) => {
    const tid = String(t.taskId || '').trim()
    if (!tid) return false
    if (tid === cid || tid.endsWith(cidTail)) return true
    const stid = String(t.collabSubtaskId || '').trim()
    return stid && (stid === cid || stid.endsWith(cidTail))
  })
}

/** Streams without collab_subtask_id (legacy Claude parallel). Only exact description match. */
function findOrphanStreamByExactDescription(tasksMap, fallbackText) {
  const orphans = Object.values(tasksMap || {}).filter((t) => !String(t.collabSubtaskId || '').trim())
  if (!orphans.length) return undefined
  const txt = String(fallbackText || '')
    .trim()
    .toLowerCase()
  if (!txt) return undefined
  const running = orphans.filter((t) => t.phase === 'running')
  const exact = (pool) =>
    pool.find((t) => String(t.description || '').trim().toLowerCase() === txt)
  return exact(running) || exact(orphans)
}

/**
 * @param {Record<string, import('../react/chat-types.js').SubagentStreamTask> | undefined} tasksMap
 * @param {string} collabSubtaskId
 * @param {string} [fallbackText]
 * @returns {import('../react/chat-types.js').SubagentStreamTask | undefined}
 */
export function findSubagentTaskForCollabSubtask(tasksMap, collabSubtaskId, fallbackText) {
  const cid = String(collabSubtaskId || '').trim()
  const all = Object.values(tasksMap || {})
  if (!all.length) return undefined

  const byId = findStreamTaskByCollabSubtaskId(tasksMap, cid)
  if (byId) return byId

  if (cid) {
    const orphan = findOrphanStreamByExactDescription(tasksMap, fallbackText)
    if (orphan) return orphan
    // Persisted Subtask_* rows: never fuzzy-match another subtask's stream.
    if (isPersistedCollabSubtaskId(cid)) return undefined
    return undefined
  }

  const txt = String(fallbackText || '').trim().toLowerCase()
  if (!txt) return undefined
  const pick = (arr) =>
    arr.find((t) => {
      const d = String(t.description || '')
        .trim()
        .toLowerCase()
      return d && (txt.includes(d) || d.includes(txt))
    })
  const running = all.filter((t) => t.phase === 'running')
  return pick(running) || pick(all)
}

/**
 * @param {Record<string, import('../react/chat-types.js').SubagentStreamTask> | undefined} tasksMap
 * @param {string} collabSubtaskId
 * @param {string} [fallbackText]
 */
export function findSubagentLiveForCollabSubtask(tasksMap, collabSubtaskId, fallbackText) {
  const preferText = (t) => {
    if (!t) return ''
    const rawLive = String(t.liveOutput || '').trim()
    const cleaned = sanitizeSubtaskLiveTicker(rawLive)
    if (cleaned) return cleaned
    const hint = String(t.progressHint || '').trim()
    if (hint) return sanitizeSubtaskLiveTicker(hint) || hint
    const tools = t.tools || []
    if (!tools.length) return ''
    const names = tools
      .map((o) => {
        const name = String(o.name || '').trim() || 'tool'
        const st = String(o.status || '').trim()
        return st ? `${name} · ${st}` : name
      })
      .filter(Boolean)
    if (!names.length) return ''
    return `工具过程：${names.slice(0, 10).join(' · ')}`
  }
  const hit = findSubagentTaskForCollabSubtask(tasksMap, collabSubtaskId, fallbackText)
  if (!hit) return { text: '', matched: false }
  const byDescText = preferText(hit)
  if (byDescText) return { text: byDescText, matched: true }
  if (Array.isArray(hit.tools) && hit.tools.length > 0) {
    return { text: `工具调用进行中（${hit.tools.length}）`, matched: true }
  }
  if (hit.phase === 'running') {
    return { text: '运行中…', matched: true }
  }
  return { text: '', matched: true }
}
