/**
 * Fetch subagent task transcript.
 *
 * Prefer in-memory stream while the worker is alive; when empty, fall back to
 * the same ``evoflow_chat_messages`` by-thread store as node / main chat
 * (API may return ``thread_id`` + persisted messages).
 *
 * @param {string} taskId - Subagent background task ID (from SubagentStreamTask.taskId)
 *   or collab ``subtask_id`` (API resolves via background_task_id / chat rows).
 * @returns {Promise<{
 *   task_id: string
 *   status: string
 *   result: string | null
 *   error: string | null
 *   started_at: string | null
 *   completed_at: string | null
 *   messages: Array<Record<string, unknown>>
 *   thread_id?: string
 *   empty: boolean
 * }>}
 */
export async function fetchSubagentTaskTranscript(taskId) {
  const tid = String(taskId || '').trim()
  if (!tid) return { empty: true, messages: [], status: 'unknown' }

  try {
    const { gatewayJson } = await import('./gateway-json.js')
    const data = await gatewayJson('GET', `/api/tasks/subagent/${encodeURIComponent(tid)}/transcript`)
    const messages = Array.isArray(data?.messages) ? data.messages : []
    const threadId = String(data?.thread_id || '').trim()

    if (messages.length > 0) {
      return { ...data, messages, empty: false }
    }

    // Same store as main chat when API only resolved the executor thread
    if (threadId) {
      try {
        const { fetchTranscriptMessagesByThread } = await import('./subtask-conversation-history.js')
        const byThread = await fetchTranscriptMessagesByThread(threadId)
        if (byThread.messages.length > 0) {
          return {
            ...data,
            messages: byThread.messages,
            thread_id: threadId,
            empty: false,
          }
        }
      } catch {
        /* keep empty */
      }
    }

    return { ...data, messages: [], empty: true }
  } catch (err) {
    if (Number(err?.status) === 404) return { empty: true, messages: [], status: 'not_found' }
    console.warn('[SubagentTranscript] fetch failed', taskId, err)
    return { empty: true, messages: [], status: 'error' }
  }
}
