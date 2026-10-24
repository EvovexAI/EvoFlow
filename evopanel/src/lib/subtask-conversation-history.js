/**
 * Subtask / node transcript — same store as main chat (`evoflow_chat_messages`).
 *
 * Prefer resolved executor ``thread_id`` → GET by-thread messages.
 * ``conversation-history`` is a thin resolver (taskId+subtaskId → thread + outcome).
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

/** Drop legacy fake turns that injected outcome into messages. */
function filterRealChatMessages(messages) {
  if (!Array.isArray(messages)) return []
  return messages.filter((m) => {
    if (!m || typeof m !== 'object') return false
    const src = String(m.source || '').trim()
    if (src === 'done') return false
    const id = String(m.id || '').trim()
    if (id.endsWith(':outcome-report')) return false
    return true
  })
}

/**
 * Same path as main chat: GET /api/chat/sessions/by-thread/{threadId}/messages
 */
export async function fetchTranscriptMessagesByThread(threadId, limit = 2000) {
  const tid = String(threadId || '').trim()
  if (!tid) return { messages: [], threadId: '', sessionKey: '' }
  try {
    const { getWsClient } = await import('./ws-client.js')
    const client = typeof getWsClient === 'function' ? getWsClient() : null
    if (client?.chatMessagesByThread) {
      const data = await client.chatMessagesByThread(tid, { all: true, limit })
      return {
        messages: filterRealChatMessages(data?.messages),
        threadId: tid,
        sessionKey: String(data?.sessionKey || ''),
      }
    }
  } catch {
    /* fall through to fetch */
  }
  const qs = new URLSearchParams()
  qs.set('all', '1')
  const path = `/api/chat/sessions/by-thread/${encodeURIComponent(tid)}/messages?${qs}`
  const res = await fetch(path, { credentials: 'same-origin' })
  if (!res.ok) {
    if (res.status === 404) return { messages: [], threadId: tid, sessionKey: '' }
    throw new Error(`GET by-thread messages failed: ${res.status}`)
  }
  const data = await res.json().catch(() => ({}))
  return {
    messages: filterRealChatMessages(data?.messages),
    threadId: tid,
    sessionKey: String(data?.sessionKey || ''),
  }
}

/**
 * Resolver: taskId+subtaskId → messages + thread_id + outcome (not a second chat protocol).
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
    if (res.status === 404) return { messages: [], count: 0, outcome: {}, thread_id: null }
    throw new Error(`GET subtask conversation-history failed: ${res.status}`)
  }
  return await res.json().catch(() => ({}))
}

/**
 * Meta only for V4 pane: resolve executor ``thread_id`` + outcome.
 * Does not build modal rows (old SubtaskModalMessageRow stack is retired).
 *
 * @param {{
 *   leadThreadId?: string,
 *   subtaskId: string,
 *   mainTaskId?: string,
 *   storedSubtaskThreadId?: string,
 *   subtaskSnapshot?: Record<string, unknown> | null,
 * }} params
 */
export async function fetchSubtaskTranscriptMeta(params) {
  const subtaskId = String(params?.subtaskId || '').trim()
  const mainTaskId = String(params?.mainTaskId || '').trim()
  let threadId = String(params?.storedSubtaskThreadId || '').trim()
  let outcome = outcomeFromSubtaskSnapshot(params?.subtaskSnapshot)
  let status = String(params?.subtaskSnapshot?.status || '').trim() || undefined

  if (mainTaskId && subtaskId) {
    try {
      const data = await fetchViaTaskConversationHistory(mainTaskId, subtaskId, 1)
      const resolved = String(data?.thread_id || '').trim()
      if (resolved) threadId = resolved
      outcome = outcomeFromApi(data?.outcome, params?.subtaskSnapshot)
      const st = String(outcome?.status || data?.status || '').trim()
      if (st) status = st
    } catch {
      /* keep stored / snapshot */
    }
  }

  return {
    task_id: mainTaskId,
    subtask_id: subtaskId,
    thread_id: threadId || undefined,
    status,
    outcome,
  }
}

/**
 * @deprecated Prefer ``fetchSubtaskTranscriptMeta`` + V4SessionPaneBridge.
 * Still returns ``rows`` for legacy drawer hosts being migrated off.
 *
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
  const storedThread = String(params?.storedSubtaskThreadId || '').trim()

  if (!subtaskId) {
    return {
      task_id: mainTaskId,
      subtask_id: subtaskId,
      count: 0,
      messages: [],
      rows: [],
      emptyConversation: true,
      thread_id: storedThread || undefined,
      status: String(params?.subtaskSnapshot?.status || '').trim() || undefined,
      outcome: outcomeFromSubtaskSnapshot(params?.subtaskSnapshot),
    }
  }

  let messages = []
  let threadId = storedThread
  let outcome = outcomeFromSubtaskSnapshot(params?.subtaskSnapshot)

  // 1) Known executor thread → same API as main chat
  if (storedThread) {
    try {
      const byThread = await fetchTranscriptMessagesByThread(storedThread, params?.limit)
      if (byThread.messages.length > 0) {
        messages = byThread.messages
      }
    } catch {
      /* resolve via history below */
    }
  }

  // 2) Resolver: stable task/subtask → thread + messages + outcome
  if (mainTaskId && messages.length === 0) {
    const data = await fetchViaTaskConversationHistory(mainTaskId, subtaskId, params?.limit)
    const resolved = String(data?.thread_id || '').trim()
    if (resolved) threadId = resolved
    outcome = outcomeFromApi(data?.outcome, params?.subtaskSnapshot)

    // Prefer by-thread when resolver gave us a thread (canonical store path)
    if (resolved) {
      try {
        const byThread = await fetchTranscriptMessagesByThread(resolved, params?.limit)
        if (byThread.messages.length > 0) {
          messages = byThread.messages
        }
      } catch {
        /* use history messages */
      }
    }
    if (messages.length === 0) {
      messages = filterRealChatMessages(data?.messages)
    }
  }

  const rows = messagesToSubtaskModalRows(messages)
  return {
    task_id: mainTaskId,
    subtask_id: subtaskId,
    count: messages.length,
    messages,
    rows,
    emptyConversation: messages.length === 0,
    thread_id: threadId || undefined,
    status:
      String(outcome?.status || '').trim() ||
      String(params?.subtaskSnapshot?.status || '').trim() ||
      undefined,
    outcome,
  }
}
