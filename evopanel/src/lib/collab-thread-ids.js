/** Collab executor thread ids — keep in sync with evoflow.collab.thread_ids. */

export const SUBTASK_THREAD_SEP = '__sub__'
const LEGACY_SUBTASK_THREAD_SEP = '::sub::'
const LANGGRAPH_LEAD_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function splitExecutorThread(threadId) {
  const tid = String(threadId || '').trim()
  if (!tid) return [null, null]
  for (const sep of [SUBTASK_THREAD_SEP, LEGACY_SUBTASK_THREAD_SEP]) {
    const idx = tid.indexOf(sep)
    if (idx >= 0) {
      const lead = tid.slice(0, idx).trim()
      const sid = tid.slice(idx + sep.length).trim()
      return [lead || null, sid || null]
    }
  }
  return [null, null]
}

/** True for subagent checkpoint threads (not lead chat session ids). */
export function isCollabExecutorThread(threadId) {
  const tid = String(threadId || '').trim()
  if (!tid) return false
  if (tid.startsWith('SubThread_')) return true
  const [lead] = splitExecutorThread(tid)
  return Boolean(lead)
}

export function normalizeLeadThreadId(threadId) {
  let tid = String(threadId || '').trim()
  if (!tid) return null
  while (true) {
    const [lead] = splitExecutorThread(tid)
    if (!lead) return tid
    tid = lead
  }
}

export function leadThreadFromExecutorThread(executorThreadId) {
  const tid = String(executorThreadId || '').trim()
  if (!tid) return null
  const [lead] = splitExecutorThread(tid)
  if (lead) return lead
  if (tid.startsWith('SubThread_')) return null
  return null
}

export function isLanggraphLeadThreadId(threadId) {
  const tid = String(threadId || '').trim()
  if (!tid || isCollabExecutorThread(tid)) return false
  return LANGGRAPH_LEAD_UUID_RE.test(tid)
}

/** Map collab executor ids to root lead UUID; pass through valid lead ids. */
export function resolveLanggraphLeadThreadId(threadId) {
  const tid = String(threadId || '').trim()
  if (!tid) return null
  if (isLanggraphLeadThreadId(tid)) return tid
  if (isCollabExecutorThread(tid)) {
    const lead = leadThreadFromExecutorThread(tid) || normalizeLeadThreadId(tid)
    if (lead && isLanggraphLeadThreadId(lead)) return lead
    return null
  }
  return null
}
