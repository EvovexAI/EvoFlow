/**
 * Collab subtask stream helpers.
 *
 * Detached subtasks are injected into the main chat ``runs/stream`` as LangGraph
 * ``event: custom`` (handled by ws-client → ``state: subtask``). No separate
 * task/panel SSE subscription is required for the sidebar marquee.
 */

const SSE_TO_SUBTASK_TYPE = {
  'task:started': 'task_started',
  'task:running': 'task_running',
  'task:completed': 'task_completed',
  'task:failed': 'task_failed',
  'task:timed_out': 'task_timed_out',
}

/**
 * @param {unknown} envelope Parsed SSE JSON `{ type, data }`
 * @returns {Record<string, unknown> | null}
 */
export function collabSseEnvelopeToSubtaskStreamEvent(envelope) {
  if (!envelope || typeof envelope !== 'object') return null
  const o = /** @type {Record<string, unknown>} */ (envelope)
  const evtType = String(o.type || '').trim()
  const data = o.data && typeof o.data === 'object' && !Array.isArray(o.data) ? { ...o.data } : {}
  const inner = String(data.type || '').trim()
  if (inner.startsWith('task_')) {
    return /** @type {Record<string, unknown>} */ (data)
  }
  const mapped = SSE_TO_SUBTASK_TYPE[evtType]
  if (!mapped) return null
  return { ...data, type: mapped }
}

/** @deprecated Subtasks use main ``runs/stream``; kept for legacy imports. */
export function subscribeThreadCollabSubtaskStream(_threadId, _onSubtaskStreamEvent, _opts = {}) {
  return { close() {} }
}

/** @deprecated Use main chat stream only. */
export const subscribeCollabTaskEventStream = subscribeThreadCollabSubtaskStream

/** @deprecated alias */
export const subscribeProjectEventStream = subscribeThreadCollabSubtaskStream
