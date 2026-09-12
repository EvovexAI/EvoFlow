/**
 * 进入会话是否查 GET /tasks：仅看会话列表返回的 collabTaskId。
 * 该字段由后端从 evoflow_thread_collab.bound_task_id 解析（thread 级唯一绑定真源）。
 */

/**
 * @param {{ collabTaskId?: string | null } | null | undefined} sessionRow
 * @param {string} [boundTaskIdHint] 任务页跳转等显式 hint（列表尚未刷新时）
 */
export function resolveSessionTaskId(sessionRow, boundTaskIdHint = '') {
  const fromRow = String(sessionRow?.collabTaskId || '').trim()
  if (fromRow) return fromRow
  return String(boundTaskIdHint || '').trim()
}

/**
 * @param {string} sessionTaskId
 */
export function sessionNeedsTaskApiLookup(sessionTaskId) {
  return !!String(sessionTaskId || '').trim()
}
