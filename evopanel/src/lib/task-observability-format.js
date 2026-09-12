/** Format task/subtask observability metrics for UI chips. */

/**
 * @param {unknown} ms
 * @returns {string}
 */
export function formatDurationMs(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n < 0) return ''
  const sec = Math.floor(n / 1000)
  if (sec < 60) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m < 60) return `${m}m${s > 0 ? `${s}s` : ''}`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return `${h}h${rm > 0 ? `${rm}m` : ''}`
}

export function formatCompactNum(n) {
  const v = Number(n) || 0
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 10_000) return `${Math.round(v / 1000)}k`
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`
  return String(v)
}

/**
 * @param {Record<string, unknown> | null | undefined} obs
 * @returns {string}
 */
export function formatSubtaskObsLine(obs) {
  if (!obs || obs.enabled === false) return ''
  const parts = []
  const durMs = Number(obs.duration_ms)
  if (Number.isFinite(durMs) && durMs > 0) {
    const durText = formatDurationMs(durMs)
    if (durText) parts.push(obs.duration_running ? `耗时 ${durText}+` : `耗时 ${durText}`)
  }
  const modelN = Number(obs.model_invocations) || 0
  const toolN = Number(obs.tool_invocations) || 0
  const tok = obs.tokens && typeof obs.tokens === 'object' ? obs.tokens : {}
  const inTok = Number(tok.input) || 0
  const outTok = Number(tok.output) || 0

  if (modelN > 0) parts.push(`模型调用 ${modelN} 次`)
  if (toolN > 0) parts.push(`工具调用 ${toolN} 次`)
  if (inTok > 0 || outTok > 0) {
    parts.push(`Token ↓${formatCompactNum(inTok)} ↑${formatCompactNum(outTok)}`)
  }
  if (obs.primary_model) parts.push(`主用模型 ${String(obs.primary_model)}`)
  return parts.join(' · ')
}

/**
 * @param {Record<string, unknown> | null | undefined} obsResponse
 * @returns {Record<string, Record<string, unknown>>}
 */
export function subtaskObsMapFromResponse(obsResponse) {
  /** @type {Record<string, Record<string, unknown>>} */
  const map = {}
  const list = obsResponse?.subtasks
  if (!Array.isArray(list)) return map
  for (const row of list) {
    if (!row || typeof row !== 'object') continue
    const id = String(row.subtask_id || row.subtaskId || '').trim()
    if (id) map[id] = row
  }
  return map
}
