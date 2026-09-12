/**
 * Subtask node transcript — from ``evoflow_chat_messages``, resolved by
 * stable ``task_id`` + ``subtask_id`` (not the volatile lead LangGraph UUID).
 */

import { messagesToSubtaskModalRows } from './subtask-modal-rows.js'

export function outcomeFromSubtaskSnapshot(subtask) {
  if (!subtask || typeof subtask !== 'object') return undefined
  const report = String(subtask.taskReport || subtask.result || subtask.outputSummary || '').trim()
  const reported = subtask.outcomeReported === true
  const outputs = Array.isArray(subtask.outputs) ? subtask.outputs : undefined
  const evidence = Array.isArray(subtask.evidence_paths)
    ? subtask.evidence_paths
    : Array.isArray(subtask.evidencePaths)
      ? subtask.evidencePaths
      : undefined
  if (!report && !reported && !(outputs && outputs.length) && !(evidence && evidence.length)) {
    return undefined
  }
  return {
    reported,
    status: String(subtask.status || '').trim() || undefined,
    task_report: report || undefined,
    summary: report || undefined,
    outputs: outputs && outputs.length ? outputs : undefined,
    evidence_paths: evidence && evidence.length ? evidence : undefined,
    outcome_reported_at: subtask.outcomeReportedAt || subtask.outcome_reported_at || null,
  }
}

function outcomeFromApi(raw, fallbackSnapshot) {
  if (raw && typeof raw === 'object' && Object.keys(raw).length) {
    const report = String(raw.task_report || raw.summary || raw.taskReport || '').trim()
    const outputs = Array.isArray(raw.outputs) ? raw.outputs : undefined
    const evidence = Array.isArray(raw.evidence_paths)
      ? raw.evidence_paths
      : Array.isArray(raw.evidencePaths)
        ? raw.evidencePaths
        : undefined
    const fallback = outcomeFromSubtaskSnapshot(fallbackSnapshot) || {}
    return {
      reported: raw.reported === true || !!report || !!(outputs && outputs.length),
      status: String(raw.status || fallback.status || '').trim() || undefined,
      task_report: report || fallback.task_report || undefined,
      summary: report || fallback.summary || undefined,
      outputs: outputs && outputs.length ? outputs : fallback.outputs,
      evidence_paths: evidence && evidence.length ? evidence : fallback.evidence_paths,
      outcome_reported_at:
        raw.outcome_reported_at || raw.outcomeReportedAt || fallback.outcome_reported_at || null,
    }
  }
  return outcomeFromSubtaskSnapshot(fallbackSnapshot)
}

/**
 * Canonical API: GET /api/tasks/{taskId}/subtasks/{subtaskId}/conversation-history
 * Backend resolves chat rows via persisted subtask_thread_id / SubThread_{sid} /
 * `%__sub__{sid}` — survives lead thread_id recreation on service restart.
 */
async function fetchViaTaskConversationHistory(mainTaskId, subtaskId, limit) {
  const mid = String(mainTaskId || '').trim()
  const sid = String(subtaskId || '').trim()
  if (!mid || !sid) return null
  const qs = new URLSearchParams()
  qs.set('limit', String(Math.max(1, Math.min(Number(limit) || 600, 5000))))
  const path = `/api/tasks/${encodeURIComponent(mid)}/subtasks/${encodeURIComponent(sid)}/conversation-history?${qs}`
  const res = await fetch(path, { credentials: 'same-origin' })
  if (!res.ok) {
    if (res.status === 404) return { messages: [], count: 0, outcome: {} }
    throw new Error(`GET subtask conversation-history failed: ${res.status}`)
  }
  return await res.json().catch(() => ({}))
}

/**
 * @param {{
 *   leadThreadId?: string,
 *   subtaskId: string,
 *   mainTaskId?: string,
 *   storedSubtaskThreadId?: string,
 *   subtaskSnapshot?: Record<string, unknown> | null,
 *   limit?: number,
 * }} params
 */
export async function fetchSubtaskConversationHistory(params) {
  const subtaskId = String(params?.subtaskId || '').trim()
  const mainTaskId = String(params?.mainTaskId || '').trim()

  if (!subtaskId) {
    return {
      task_id: mainTaskId,
      subtask_id: subtaskId,
      count: 0,
      messages: [],
      rows: [],
      emptyConversation: true,
      outcome: outcomeFromSubtaskSnapshot(params?.subtaskSnapshot),
    }
  }

  // Prefer task-scoped API (stable ids). Do not invent lead__sub__ from current lead UUID.
  let messages = []
  let outcome = outcomeFromSubtaskSnapshot(params?.subtaskSnapshot)
  if (mainTaskId) {
    const data = await fetchViaTaskConversationHistory(mainTaskId, subtaskId, params?.limit)
    messages = Array.isArray(data?.messages) ? data.messages : []
    outcome = outcomeFromApi(data?.outcome, params?.subtaskSnapshot)
  }

  const rows = messagesToSubtaskModalRows(messages)
  return {
    task_id: mainTaskId,
    subtask_id: subtaskId,
    count: messages.length,
    messages,
    rows,
    emptyConversation: messages.length === 0,
    outcome,
  }
}
