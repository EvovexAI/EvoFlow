/**
 * Seed / fallback rows for collab subtask transcript pane when chat history is empty.
 */

/**
 * @param {Record<string, unknown> | null | undefined} outcome
 * @returns {unknown[]}
 */
export function displayRowsFromOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object') return []
  const report = String(outcome.task_report || outcome.summary || '').trim()
  /** @type {unknown[]} */
  const out = []
  if (report) {
    out.push({
      role: 'assistant',
      text: report,
      timestamp: Date.now(),
    })
  }
  const outputs = Array.isArray(outcome.outputs) ? outcome.outputs : []
  const evidence = Array.isArray(outcome.evidence_paths) ? outcome.evidence_paths : []
  /** @type {string[]} */
  const pathLines = []
  for (const item of outputs) {
    if (!item || typeof item !== 'object') continue
    const row = /** @type {Record<string, unknown>} */ (item)
    const label = String(row.label || row.key || '').trim()
    const value = String(row.value || '').trim()
    if (!value) continue
    pathLines.push(label ? `${label}: ${value}` : value)
  }
  for (const p of evidence) {
    const s = String(p || '').trim()
    if (s && !pathLines.includes(s)) pathLines.push(s)
  }
  if (pathLines.length) {
    out.push({
      role: 'assistant',
      text: `产出文件\n${pathLines.map((l) => `- ${l}`).join('\n')}`,
      timestamp: Date.now(),
    })
  }
  return out
}

/**
 * @param {unknown[] | null | undefined} fetched
 * @param {Record<string, unknown> | null | undefined} outcome
 * @returns {unknown[]}
 */
export function coalesceSubtaskTranscriptRows(fetched, outcome) {
  if (Array.isArray(fetched) && fetched.length > 0) return fetched
  return displayRowsFromOutcome(outcome)
}
