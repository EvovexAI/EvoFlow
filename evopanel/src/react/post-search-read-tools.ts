/**
 * Expand search_code_index tool output (<post_search_reads>) into synthetic read_file rows for UI.
 * Scheduler batch reads are embedded in the tool result text, not separate LangGraph tool_calls.
 */

function toolCallIdOf(tool: Record<string, unknown>): string {
  return String(tool.tool_call_id ?? tool.id ?? '').trim()
}

function readPathFromToolRow(tool: Record<string, unknown>): string {
  const input = tool.input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ''
  const path = (input as Record<string, unknown>).path
  return typeof path === 'string' ? path.trim() : ''
}

/** Keep first row per tool_call_id so React keys stay unique in ToolCallList. */
export function dedupeToolsByCallId(tools: unknown[] | undefined): unknown[] {
  if (!Array.isArray(tools) || !tools.length) return tools || []
  const out: unknown[] = []
  const seen = new Set<string>()
  for (const tool of tools) {
    const t = tool as Record<string, unknown>
    const id = toolCallIdOf(t)
    if (id) {
      if (seen.has(id)) continue
      seen.add(id)
    }
    out.push(tool)
  }
  return out
}

function parsePostSearchReadTools(parentToolCallId: string, output: string): Record<string, unknown>[] {
  const text = String(output || '')
  if (!text.trim()) return []
  const hasBatchBlock = /<post_search_reads/i.test(text)
  const hasReadSummaries = /\[tool:summary\]\s*tool=read_file/i.test(text)
  if (!hasBatchBlock && !hasReadSummaries) return []
  const parent = parentToolCallId.trim() || 'search'
  const out: Record<string, unknown>[] = []
  const parts = text.split(/\[tool:summary\]\s*tool=read_file/gi)
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i] || ''
    const pathM = seg.match(/^\s*\r?\npath:\s*(.+?)(?:\r?\n|$)/i)
    if (!pathM) continue
    const path = pathM[1].trim()
    const coreM = seg.match(/\r?\ncore:\s*([\s\S]*?)(?=\r?\n\r?\n|\r?\n\[tool:summary\]|$)/i)
    const core = coreM ? coreM[1].trim() : ''
    const id = `${parent}:post-search-read:${i - 1}`
    out.push({
      id,
      tool_call_id: id,
      name: 'read_file',
      input: { path, invocation_source: 'post_search' },
      output: core.slice(0, 12000),
      status: 'completed',
    })
  }
  return out
}

/** After each search_code_index row, insert scheduler post-search read_file rows for ToolCallList. */
export function expandToolsWithPostSearchReads(tools: unknown[] | undefined): unknown[] {
  const base = dedupeToolsByCallId(tools)
  if (!base.length) return base
  const expanded: unknown[] = []
  const seenIds = new Set<string>()
  const readPathsSeen = new Set<string>()
  for (const tool of base) {
    const t = tool as Record<string, unknown>
    const id = toolCallIdOf(t)
    if (id) {
      if (seenIds.has(id)) continue
      seenIds.add(id)
    }
    const name = String(t.name ?? t.tool_name ?? '').trim().toLowerCase()
    if (name === 'read_file') {
      if (id.includes(':post-search-read:')) continue
      const path = readPathFromToolRow(t)
      if (path) readPathsSeen.add(path)
    }
    expanded.push(tool)
    if (name !== 'search_code_index') continue
    const output = String(t.output ?? t.output_text ?? '').trim()
    if (!output) continue
    const parentId = id || 'search_code_index'
    for (const row of parsePostSearchReadTools(parentId, output)) {
      const rid = toolCallIdOf(row)
      const path = readPathFromToolRow(row)
      if (path && readPathsSeen.has(path)) continue
      if (rid && seenIds.has(rid)) continue
      if (rid) seenIds.add(rid)
      if (path) readPathsSeen.add(path)
      expanded.push(row)
    }
  }
  return expanded
}

export { parsePostSearchReadTools }
