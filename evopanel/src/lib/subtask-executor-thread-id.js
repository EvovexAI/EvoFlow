/** Mirror backend ``collab_subtask_executor_thread_id`` / ``resolve_subtask_executor_thread_id``. */

const SUBTASK_THREAD_SEP = '__sub__'
const LEGACY_SUBTASK_THREAD_SEP = '::sub::'

function splitExecutorThread(threadId) {
  const tid = String(threadId || '').trim()
  if (!tid) return { lead: null, subtaskId: null }
  for (const sep of [SUBTASK_THREAD_SEP, LEGACY_SUBTASK_THREAD_SEP]) {
    if (tid.includes(sep)) {
      const [lead, sid] = tid.split(sep, 2)
      return { lead: String(lead || '').trim() || null, subtaskId: String(sid || '').trim() || null }
    }
  }
  return { lead: null, subtaskId: null }
}

function normalizeLeadThreadId(threadId) {
  let tid = String(threadId || '').trim()
  if (!tid) return ''
  for (;;) {
    const { lead } = splitExecutorThread(tid)
    if (!lead) return tid
    tid = lead
  }
}

/** True for subagent checkpoint threads (not lead chat session ids). */
export function isCollabExecutorThread(threadId) {
  const tid = String(threadId || '').trim()
  if (!tid) return false
  if (tid.startsWith('SubThread_')) return true
  const { lead } = splitExecutorThread(tid)
  return lead != null
}

/**
 * Lead thread used when listing subtask chat messages.
 * Never treat ``SubThread_*`` / ``{lead}__sub__{sid}`` as lead — that is the worker transcript id.
 */
export function resolveLeadThreadIdForHistory(threadId) {
  const tid = String(threadId || '').trim()
  if (!tid || isCollabExecutorThread(tid)) return ''
  return normalizeLeadThreadId(tid) || tid
}

/**
 * @param {string} leadThreadId LangGraph lead thread uuid (empty for workflow app runs)
 * @param {string} subtaskId persisted Subtask_* id
 * @param {string} [storedSubtaskThreadId] optional subtask_row.subtask_thread_id
 */
export function collabSubtaskExecutorThreadId(leadThreadId, subtaskId, storedSubtaskThreadId = '') {
  // Mis-passed current_execution_thread_id (itself SubThread_*) must not become lead prefix
  const lead = resolveLeadThreadIdForHistory(leadThreadId)
  const sid = String(subtaskId || '').trim()
  let stored = String(storedSubtaskThreadId || '').trim()
  if (stored.includes(LEGACY_SUBTASK_THREAD_SEP)) {
    stored = stored.replace(LEGACY_SUBTASK_THREAD_SEP, SUBTASK_THREAD_SEP)
  }
  const canonical = lead && sid ? `${lead}${SUBTASK_THREAD_SEP}${sid}` : ''

  // Prefer persisted worker thread (survives lead UUID recreation after restart)
  if (stored && sid) {
    if (stored === `SubThread_${sid}`) return stored
    const { lead: storedLeadSeg, subtaskId: storedSid } = splitExecutorThread(stored)
    if (String(storedSid || '').trim() === sid) {
      const storedRoot = normalizeLeadThreadId(storedLeadSeg || '') || String(storedLeadSeg || '').trim()
      if (!lead) return stored
      if (storedRoot === lead) return canonical || stored
      return stored
    }
  }
  if (stored && canonical && stored === canonical) return stored
  if (canonical) return canonical
  if (stored) return stored
  if (sid) return `SubThread_${sid}`
  return `SubThread_${lead || 'orphan'}`
}
