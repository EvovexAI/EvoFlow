/**
 * Fetch subagent task transcript from the in-memory background store.
 *
 * Called on a polling interval while the modal is open.
 * The returned `messages` array contains raw LangChain message dicts
 * (HumanMessage / AIMessage / ToolMessage with tool_calls etc.) and is fed
 * directly into `messagesToSubtaskModalRows` from `subtask-modal-rows.js`,
 * which is the same pipeline the main conversation and task-center subtask
 * modal use. No bespoke parsing here.
 *
 * @param {string} taskId - Subagent background task ID (from SubagentStreamTask.taskId)
 * @returns {Promise<{
 *   task_id: string
 *   status: string
 *   result: string | null
 *   error: string | null
 *   started_at: string | null
 *   completed_at: string | null
 *   messages: Array<Record<string, unknown>>
 *   empty: boolean
 * }>}
 */
export async function fetchSubagentTaskTranscript(taskId) {
  const tid = String(taskId || '').trim()
  if (!tid) return { empty: true, messages: [], status: 'unknown' }

  try {
    const { gatewayJson } = await import('./gateway-json.js')
    return await gatewayJson('GET', `/api/tasks/subagent/${encodeURIComponent(tid)}/transcript`)
  } catch (err) {
    if (Number(err?.status) === 404) return { empty: true, messages: [], status: 'not_found' }
    console.warn('[SubagentTranscript] fetch failed', taskId, err)
    return { empty: true, messages: [], status: 'error' }
  }
}
