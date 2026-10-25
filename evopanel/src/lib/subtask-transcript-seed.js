/**
 * Seed / fallback for collab subtask transcript pane.
 * Conversation rows stay conversational; outcome (结案摘要) is separate — never
 * fake a single "assistant" bubble from the final task_report.
 *
 * Backend keeps Lead-facing ``task_report`` self-contained by appending
 * 「产出路径：」 into the same text field, while also storing structured
 * ``outputs`` / ``evidence_paths``. UI must split them for tabs.
 */

const _OUTPUT_PATHS_MARKER = /(?:^|\n)\s*产出路径：\s*\n/

/**
 * Split Lead-facing report text into summary vs embedded path bullets.
 * @param {string} raw
 * @returns {{ report: string, embeddedPaths: string[] }}
 */
export function splitEmbeddedOutputPaths(raw) {
  const text = String(raw || '').trim()
  if (!text) return { report: '', embeddedPaths: [] }
  const match = _OUTPUT_PATHS_MARKER.exec(text)
  if (!match || match.index == null) return { report: text, embeddedPaths: [] }
  const report = text.slice(0, match.index).trim()
  const tail = text.slice(match.index + match[0].length)
  /** @type {string[]} */
  const embeddedPaths = []
  for (const line of tail.split(/\r?\n/)) {
    const s = String(line || '')
      .trim()
      .replace(/^[-*]\s+/, '')
      .replace(/^`(.+)`$/, '$1')
      .trim()
    if (s && !embeddedPaths.includes(s)) embeddedPaths.push(s)
  }
  return { report, embeddedPaths }
}

/**
 * @param {Record<string, unknown> | null | undefined} outcome
 * @returns {{ report: string, pathLines: string[] }}
 */
export function summarizeOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object') return { report: '', pathLines: [] }
  const { report, embeddedPaths } = splitEmbeddedOutputPaths(
    String(outcome.task_report || outcome.summary || ''),
  )
  /** @type {string[]} */
  const pathLines = []
  const outputs = Array.isArray(outcome.outputs) ? outcome.outputs : []
  for (const item of outputs) {
    if (!item || typeof item !== 'object') continue
    const row = /** @type {Record<string, unknown>} */ (item)
    const label = String(row.label || row.key || '').trim()
    const value = String(row.value || '').trim()
    if (!value) continue
    pathLines.push(label ? `${label}: ${value}` : value)
  }
  const evidence = Array.isArray(outcome.evidence_paths) ? outcome.evidence_paths : []
  for (const p of evidence) {
    const s = String(p || '').trim()
    if (s && !pathLines.includes(s)) pathLines.push(s)
  }
  for (const p of embeddedPaths) {
    if (p && !pathLines.includes(p)) pathLines.push(p)
  }
  return { report, pathLines }
}
/**
 * @deprecated Prefer summarizeOutcome + separate UI. Kept for tests that still assert
 * legacy shape; do not feed these into the conversation timeline as fake turns.
 * @param {Record<string, unknown> | null | undefined} outcome
 * @returns {unknown[]}
 */
export function displayRowsFromOutcome(outcome) {
  const { report, pathLines } = summarizeOutcome(outcome)
  /** @type {unknown[]} */
  const out = []
  if (report) {
    out.push({
      role: 'assistant',
      text: report,
      timestamp: Date.now(),
      _source: 'outcome-summary',
    })
  }
  if (pathLines.length) {
    out.push({
      role: 'assistant',
      text: `产出文件\n${pathLines.map((l) => `- ${l}`).join('\n')}`,
      timestamp: Date.now(),
      _source: 'outcome-summary',
    })
  }
  return out
}

/**
 * Only real conversation rows. Empty history → [] (caller may show outcome aside).
 * @param {unknown[] | null | undefined} fetched
 * @param {Record<string, unknown> | null | undefined} _outcome unused (kept for call-site compat)
 * @returns {unknown[]}
 */
export function coalesceSubtaskTranscriptRows(fetched, _outcome) {
  if (Array.isArray(fetched) && fetched.length > 0) return fetched
  return []
}
