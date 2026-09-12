import {
  getToolInputObjectFromRow,
  isToolRunning,
} from '../lib/chat-normalize.js'
import { resolveEffectiveToolName, resolveToolKey } from '../lib/tool-display.js'

export type WorkerFileEntry = {
  id: string
  kind: 'file' | 'search'
  path: string
  query?: string
  action: string
  instruction?: string
  content?: string
  old_string?: string
  new_string?: string
  before_content?: string
  after_content?: string
  inner_tools?: unknown[]
  running: boolean
  ok?: boolean
  result?: string
  toolKind: string
  toolCallId?: string
  /** 子 worker 已结束，可向占位区填充 diff / 结果 */
  filled: boolean
}

export type WorkerReportSlice = {
  ok: boolean
  text: string
  content?: string
  old_string?: string
  new_string?: string
  before_content?: string
  after_content?: string
  instruction?: string
  action?: string
  path?: string
  query?: string
  inner_tools?: unknown[]
}

function workerProgressMap(parentTool: Record<string, unknown>): Map<number, WorkerReportSlice> {
  const map = new Map<number, WorkerReportSlice>()
  const raw = parentTool._workerFileProgress
  if (!raw || typeof raw !== 'object') return map
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const index = Number(key)
    if (!Number.isFinite(index) || !value || typeof value !== 'object') continue
    const row = value as Record<string, unknown>
    map.set(index, {
      ok: row.ok !== false,
      text: String(row.preview || row.output_preview || row.error || '').trim(),
      content: typeof row.content === 'string' ? row.content : undefined,
      old_string: typeof row.old_string === 'string' ? row.old_string : undefined,
      new_string: typeof row.new_string === 'string' ? row.new_string : undefined,
      before_content: typeof row.before_content === 'string' ? row.before_content : undefined,
      after_content: typeof row.after_content === 'string' ? row.after_content : undefined,
      instruction: typeof row.instruction === 'string' ? row.instruction : undefined,
      action: typeof row.action === 'string' ? row.action : undefined,
      path: typeof row.path === 'string' ? row.path : undefined,
      query: typeof row.query === 'string' ? row.query : undefined,
      inner_tools: Array.isArray(row.inner_tools) ? row.inner_tools : undefined,
    })
  }
  return map
}

function toolCallIdOf(tool: Record<string, unknown>): string {
  return String(tool.tool_call_id ?? tool.id ?? '').trim()
}

function actionToToolKind(action: string): string {
  const a = String(action || '').trim().toLowerCase()
  if (a === 'write') return 'write_to_file'
  if (a === 'replace') return 'replace_in_file'
  if (a === 'delete') return 'delete_file'
  if (a === 'search') return 'search_code_index'
  return 'replace_in_file'
}

function strField(obj: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const v = obj?.[key]
  return typeof v === 'string' ? v : undefined
}

function toolOutputText(tool: Record<string, unknown> | undefined): string {
  if (!tool) return ''
  const raw = tool.output ?? tool.output_text ?? tool.content
  if (raw == null) return ''
  return String(raw).trim()
}

function parseWorkerResultJson(
  text: string,
  tag: 'worker_file_results' | 'worker_search_results',
): Map<number, WorkerReportSlice> {
  const map = new Map<number, WorkerReportSlice>()
  const jsonMatch = text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'i'))
  if (!jsonMatch) return map
  try {
    const rows = JSON.parse(jsonMatch[1]) as unknown[]
    if (!Array.isArray(rows)) return map
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      const index = Number(r.index)
      if (!Number.isFinite(index)) continue
      map.set(index, {
        ok: r.ok !== false,
        text: String(r.preview || r.error || '').trim(),
        content: typeof r.content === 'string' ? r.content : undefined,
        old_string: typeof r.old_string === 'string' ? r.old_string : undefined,
        new_string: typeof r.new_string === 'string' ? r.new_string : undefined,
        before_content: typeof r.before_content === 'string' ? r.before_content : undefined,
        after_content: typeof r.after_content === 'string' ? r.after_content : undefined,
        instruction: typeof r.instruction === 'string' ? r.instruction : undefined,
        action: typeof r.action === 'string' ? r.action : undefined,
        path: typeof r.path === 'string' ? r.path : undefined,
        query: typeof r.query === 'string' ? r.query : undefined,
        inner_tools: Array.isArray(r.inner_tools) ? r.inner_tools : undefined,
      })
    }
  } catch {
    return map
  }
  return map
}

/** Parse parent worker `<execution_report>` into per-index result slices. */
export function parseWorkerExecutionReport(output: unknown): Map<number, WorkerReportSlice> {
  const text = output == null ? '' : String(output)

  const searchMap = parseWorkerResultJson(text, 'worker_search_results')
  if (searchMap.size) return searchMap

  const fileMap = parseWorkerResultJson(text, 'worker_file_results')
  if (fileMap.size) return fileMap

  const map = new Map<number, WorkerReportSlice>()
  if (!text.includes('<execution_report>')) return map
  const re =
    /--- op=worker=(\d+) (?:path=[^\s]+|query=[^\s]+) action=\S+ ok=(true|false)\n([\s\S]*?)(?=\n--- op=|\n<\/execution_report>|$)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const index = parseInt(m[1], 10)
    if (!Number.isFinite(index)) continue
    map.set(index, {
      ok: String(m[2]).toLowerCase() === 'true',
      text: String(m[3] || '').trim(),
    })
  }
  return map
}

function taskKeyFromTask(task: Record<string, unknown>): string {
  const action = String(task.action || '').trim().toLowerCase()
  if (action === 'search') return String(task.query || '').trim()
  return String(task.path || '').trim()
}

/** Fallback when backend inner_tools missing: synthesize from child search_code_index row. */
function buildInnerToolsFromChild(
  child: Record<string, unknown> | undefined,
  task: Record<string, unknown>,
  parentId: string,
  index: number,
): unknown[] | undefined {
  if (!child) return undefined
  const name = resolveEffectiveToolName(child).toLowerCase()
  if (name !== 'search_code_index' && name !== 'worker') return undefined
  const output = toolOutputText(child)
  if (!output) return undefined
  const childInput = (getToolInputObjectFromRow(child) || {}) as Record<string, unknown>
  const tcId = toolCallIdOf(child) || `${parentId || 'worker'}:search:${index}`
  const readLimitRaw = task.read_limit ?? childInput.read_limit
  const readLimit =
    typeof readLimitRaw === 'number' ? readLimitRaw : Number.parseInt(String(readLimitRaw || ''), 10)
  return [
    {
      id: `${tcId}:search:0`,
      tool_call_id: `${tcId}:search:0`,
      name: 'search_code_index',
      input: {
        query: String(task.query || childInput.query || '').trim(),
        read_limit: Number.isFinite(readLimit) ? readLimit : 0,
        invocation_source: 'worker',
        parent_worker_tool_call_id: parentId,
      },
      output,
      status: 'completed',
    },
  ]
}

/** Merge worker(tasks[]) parent input with per-task prefetch child tools for UI. */
export function collectWorkerFileEntries(
  parentTool: Record<string, unknown>,
  allTools: unknown[] | undefined,
): WorkerFileEntry[] {
  const parentId = toolCallIdOf(parentTool)
  const input = (getToolInputObjectFromRow(parentTool) || {}) as Record<string, unknown>
  const tasks = Array.isArray(input.tasks) ? input.tasks : []
  if (!tasks.length) return []

  const reportByIndex = parseWorkerExecutionReport(parentTool.output ?? parentTool.output_text)
  const progressByIndex = workerProgressMap(parentTool as Record<string, unknown>)
  const parentDone = !isToolRunning(parentTool)

  const childByIndex = new Map<number, Record<string, unknown>>()
  const childByKey = new Map<string, Record<string, unknown>>()
  for (const raw of allTools || []) {
    const child = raw as Record<string, unknown>
    const args = (getToolInputObjectFromRow(child) || {}) as Record<string, unknown>
    const parentRef = String(args.parent_worker_tool_call_id || '').trim()
    if (parentRef && parentRef !== parentId) continue
    const id = toolCallIdOf(child)
    const m = id.match(/^worker-(\d+)-/)
    if (m) childByIndex.set(parseInt(m[1], 10), child)
    const key = String(args.query || args.path || '').trim()
    if (key) childByKey.set(key, child)
  }

  return tasks.map((rawTask, index) => {
    const task = (rawTask && typeof rawTask === 'object' ? rawTask : {}) as Record<string, unknown>
    const taskKey = taskKeyFromTask(task)
    const child = childByIndex.get(index) || (taskKey ? childByKey.get(taskKey) : undefined)
    const childInput = child
      ? ((getToolInputObjectFromRow(child) || {}) as Record<string, unknown>)
      : {}
    const childName = child ? resolveEffectiveToolName(child) : ''
    const reportSliceEarly = reportByIndex.get(index) || progressByIndex.get(index)
    let resolvedAction = String(
      task.action || childInput.action || reportSliceEarly?.action || '',
    )
      .trim()
      .toLowerCase()
    if (!resolvedAction && (task.query || childInput.query) && !(task.path || childInput.path)) {
      resolvedAction = 'search'
    }
    if (!resolvedAction && childName.toLowerCase() === 'search_code_index') {
      resolvedAction = 'search'
    }
    if (!resolvedAction) resolvedAction = 'edit'
    const kind: 'file' | 'search' = resolvedAction === 'search' ? 'search' : 'file'

    const childDone = Boolean(child && !isToolRunning(child))
    const progressSlice = progressByIndex.get(index)
    const finalReportSlice = reportByIndex.get(index)
    const reportSlice = finalReportSlice ?? progressSlice
    const parentRunning = isToolRunning(parentTool)
    const childRunning = Boolean(child && isToolRunning(child))
    const streamingProgress = Boolean(progressSlice) && !finalReportSlice && parentRunning

    const filled =
      parentDone ||
      childDone ||
      Boolean(finalReportSlice) ||
      (Boolean(progressSlice) && !parentRunning && !childRunning)
    const running = streamingProgress || (!filled && (childRunning || parentRunning))
    const showPayload = filled && !running

    const childStatus = child ? String(child.status || '').toLowerCase() : ''
    const childOutput = toolOutputText(child)
    let ok: boolean | undefined
    if (filled) {
      if (reportSlice) ok = reportSlice.ok
      else if (child) ok = childStatus !== 'error' && childStatus !== 'failed'
      else ok = parentDone
    }

    let result: string | undefined
    if (filled && ok === false) {
      if (childOutput) result = childOutput
      else if (reportSlice?.text) result = reportSlice.text
    }

    const query =
      kind === 'search'
        ? String(reportSlice?.query || task.query || childInput.query || taskKey || '').trim()
        : undefined

    return {
      id: `${parentId || 'worker'}:${kind}:${index}`,
      kind,
      path: kind === 'file' ? String(task.path || reportSlice?.path || childInput.path || '') : '',
      query,
      action: String(reportSlice?.action || resolvedAction).trim().toLowerCase(),
      instruction: showPayload
        ? reportSlice?.instruction ?? strField(task, 'instruction') ?? strField(childInput, 'instruction')
        : undefined,
      content: showPayload
        ? reportSlice?.content ?? strField(task, 'content') ?? strField(childInput, 'content')
        : undefined,
      old_string: showPayload
        ? reportSlice?.old_string ?? strField(task, 'old_string') ?? strField(childInput, 'old_string')
        : undefined,
      new_string: showPayload
        ? reportSlice?.new_string ?? strField(task, 'new_string') ?? strField(childInput, 'new_string')
        : undefined,
      before_content: showPayload
        ? reportSlice?.before_content ?? progressSlice?.before_content
        : undefined,
      after_content: showPayload
        ? reportSlice?.after_content ?? progressSlice?.after_content
        : undefined,
      inner_tools: showPayload
        ? reportSlice?.inner_tools
          ?? progressSlice?.inner_tools
          ?? (kind === 'search'
            ? buildInnerToolsFromChild(child, task, parentId, index)
            : undefined)
        : undefined,
      running,
      ok: filled ? ok : undefined,
      result: filled ? (kind === 'search' ? reportSlice?.text || result : result) : undefined,
      toolKind: childName ? resolveToolKey(childName) : actionToToolKind(resolvedAction),
      toolCallId: child ? toolCallIdOf(child) || undefined : undefined,
      filled,
    }
  })
}

export function workerFileProgress(entries: WorkerFileEntry[]): { done: number; total: number } {
  const total = entries.length
  const done = entries.filter((e) => e.filled && !e.running).length
  return { done, total }
}

export function workerBatchKind(entries: WorkerFileEntry[]): 'file' | 'search' | 'mixed' {
  const kinds = new Set(entries.map((e) => e.kind))
  if (kinds.size === 1) return kinds.has('search') ? 'search' : 'file'
  return 'mixed'
}

/** worker 批次是否仅含 search 任务（应收进 Exploring，不切 standalone） */
export function isWorkerSearchOnlyTool(tool: unknown): boolean {
  const t = tool as Record<string, unknown>
  if (resolveToolKey(t) !== 'worker') return false
  const input = (getToolInputObjectFromRow(t) || {}) as Record<string, unknown>
  const tasks = Array.isArray(input.tasks) ? input.tasks : []
  if (!tasks.length) return false
  for (const raw of tasks) {
    if (!raw || typeof raw !== 'object') return false
    const action = String((raw as Record<string, unknown>).action || '').trim().toLowerCase()
    if (action !== 'search') return false
  }
  return true
}

/** Merge per-task search rows for ToolCallList (same shape as main-thread search_code_index). */
export function collectWorkerSearchTools(
  parentTool: Record<string, unknown>,
  allTools: unknown[] | undefined,
): unknown[] {
  const entries = collectWorkerFileEntries(parentTool, allTools)
  const parentId = toolCallIdOf(parentTool)
  const input = (getToolInputObjectFromRow(parentTool) || {}) as Record<string, unknown>
  const tasks = Array.isArray(input.tasks) ? input.tasks : []

  const merged: unknown[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.kind !== 'search') continue

    if (Array.isArray(entry.inner_tools) && entry.inner_tools.length) {
      merged.push(...entry.inner_tools)
      continue
    }

    const task = (tasks[i] || {}) as Record<string, unknown>
    const readLimitRaw = task.read_limit
    const readLimit =
      typeof readLimitRaw === 'number'
        ? readLimitRaw
        : Number.parseInt(String(readLimitRaw || ''), 10)

    let childTool: Record<string, unknown> | undefined
    for (const raw of allTools || []) {
      const child = raw as Record<string, unknown>
      const args = (getToolInputObjectFromRow(child) || {}) as Record<string, unknown>
      if (String(args.parent_worker_tool_call_id || '').trim() !== parentId) continue
      const id = toolCallIdOf(child)
      const m = id.match(/^worker-(\d+)-/)
      if (m && parseInt(m[1], 10) === i) {
        childTool = child
        break
      }
    }

    if (childTool) {
      const name = resolveEffectiveToolName(childTool).toLowerCase()
      if (name === 'search_code_index') {
        const childInput = (getToolInputObjectFromRow(childTool) || {}) as Record<string, unknown>
        const tcId = toolCallIdOf(childTool) || `${parentId}:search:${i}`
        const output = toolOutputText(childTool)
        const running = isToolRunning(childTool) || entry.running
        merged.push({
          id: `${tcId}:search:0`,
          tool_call_id: `${tcId}:search:0`,
          name: 'search_code_index',
          input: {
            query: String(entry.query || childInput.query || '').trim(),
            read_limit: Number.isFinite(readLimit) ? readLimit : 0,
            instruction: entry.instruction || childInput.instruction,
            invocation_source: 'worker',
            parent_worker_tool_call_id: parentId,
            ...(childInput.queries != null ? { queries: childInput.queries } : {}),
            ...(childInput.limit != null ? { limit: childInput.limit } : {}),
          },
          ...(output ? { output } : {}),
          status: running ? 'running' : entry.ok === false ? 'error' : output ? 'completed' : 'running',
        })
        continue
      }
    }

    merged.push({
      id: `${parentId}:search:${i}`,
      tool_call_id: `${parentId}:search:${i}`,
      name: 'search_code_index',
      input: {
        query: entry.query || '',
        read_limit: Number.isFinite(readLimit) ? readLimit : 0,
        instruction: entry.instruction,
        invocation_source: 'worker',
        parent_worker_tool_call_id: parentId,
      },
      ...(entry.result && entry.filled ? { output: entry.result } : {}),
      status: entry.running ? 'running' : entry.ok === false ? 'error' : entry.filled ? 'completed' : 'running',
    })
  }
  return merged
}

export function isWorkerParentTool(tool: unknown): boolean {
  const t = tool as Record<string, unknown>
  return resolveToolKey(t) === 'worker'
}

/** Inner tools to show instead of the worker wrapper (search / locate / file batch). */
export function collectWorkerInnerDisplayTools(
  parentTool: Record<string, unknown>,
  allTools: unknown[] | undefined,
): unknown[] {
  const parentId = toolCallIdOf(parentTool)
  const seen = new Set<string>()
  const out: unknown[] = []

  const push = (tool: unknown) => {
    if (!tool || typeof tool !== 'object') return
    const id = toolCallIdOf(tool as Record<string, unknown>)
    if (!id || seen.has(id)) return
    seen.add(id)
    out.push(tool)
  }

  for (const raw of allTools || []) {
    const child = raw as Record<string, unknown>
    const args = (getToolInputObjectFromRow(child) || {}) as Record<string, unknown>
    if (String(args.parent_worker_tool_call_id || '').trim() !== parentId) continue
    push(child)
  }

  for (const t of collectWorkerSearchTools(parentTool, allTools)) {
    const id = toolCallIdOf(t as Record<string, unknown>)
    if (!id) continue
    const baseId = id.replace(/:search:\d+$/, '')
    if (seen.has(id) || seen.has(baseId)) continue
    push(t)
  }

  for (const entry of collectWorkerFileEntries(parentTool, allTools)) {
    if (Array.isArray(entry.inner_tools)) {
      for (const it of entry.inner_tools) push(it)
    }
  }

  return out
}

function dedupeWorkerInnerToolIds(ids: string[]): string[] {
  const bases = new Set(ids.filter((id) => !/:search:\d+$/.test(String(id))))
  const out: string[] = []
  for (const raw of ids) {
    const id = String(raw || '').trim()
    if (!id) continue
    if (/:search:\d+$/.test(id) && bases.has(id.replace(/:search:\d+$/, ''))) continue
    if (!out.includes(id)) out.push(id)
  }
  return out
}

export function buildWorkerToolExpansionMap(tools: unknown[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const raw of tools || []) {
    if (!isWorkerParentTool(raw)) continue
    const parentId = toolCallIdOf(raw as Record<string, unknown>)
    if (!parentId) continue
    const ids = dedupeWorkerInnerToolIds(
      collectWorkerInnerDisplayTools(raw as Record<string, unknown>, tools)
        .map((t) => toolCallIdOf(t as Record<string, unknown>))
        .filter(Boolean),
    )
    if (ids.length) map.set(parentId, ids)
  }
  return map
}

export function tagWorkerDisplayExpand(tool: unknown): unknown {
  if (!tool || typeof tool !== 'object') return tool
  const o = tool as Record<string, unknown>
  if (o._workerDisplayExpand) return tool
  return { ...o, _workerDisplayExpand: true }
}

function expandWorkerToolIdsInSegmentIds(ids: string[], expansion: Map<string, string[]>): string[] {
  const expanded: string[] = []
  for (const rawId of ids || []) {
    const id = String(rawId || '').trim()
    if (!id) continue
    const repl = expansion.get(id)
    if (repl?.length) {
      for (const cid of repl) {
        if (!expanded.includes(cid)) expanded.push(cid)
      }
      continue
    }
    if (!expanded.includes(id)) expanded.push(id)
  }
  return expanded
}

/** Replace worker ids in timeline with inner concurrent tools; merge synthesized child rows into tools. */
export function prepareWorkerToolsForDisplayRow(
  tools: unknown[],
  segments: Array<{ kind: string; ids?: string[]; [key: string]: unknown }> | undefined,
): { tools: unknown[]; segments: typeof segments } {
  const list = Array.isArray(tools) ? tools : []
  const expansion = buildWorkerToolExpansionMap(list)
  if (!expansion.size) return { tools: list, segments }

  const innerDisplayIds = new Set<string>()
  for (const ids of expansion.values()) {
    for (const id of ids) innerDisplayIds.add(id)
  }

  const merged = list.map((raw) => {
    const id = toolCallIdOf(raw as Record<string, unknown>)
    if (id && innerDisplayIds.has(id)) return tagWorkerDisplayExpand(raw)
    return raw
  })
  const existing = new Set(
    merged.map((t) => toolCallIdOf(t as Record<string, unknown>)).filter(Boolean),
  )
  for (const raw of list) {
    if (!isWorkerParentTool(raw)) continue
    for (const inner of collectWorkerInnerDisplayTools(raw as Record<string, unknown>, list)) {
      const id = toolCallIdOf(inner as Record<string, unknown>)
      if (id && !existing.has(id)) {
        existing.add(id)
        merged.push(tagWorkerDisplayExpand(inner))
      }
    }
  }

  const newSegments = Array.isArray(segments)
    ? segments.map((seg) => {
        if (seg?.kind !== 'tools' || !Array.isArray(seg.ids)) return seg
        return {
          ...seg,
          ids: expandWorkerToolIdsInSegmentIds(seg.ids, expansion),
        }
      })
    : segments

  return { tools: merged, segments: newSegments }
}

/** Hide worker wrapper when inner concurrent tools are shown as separate rows. */
export function omitWorkerParentWhenExpanded(tools: unknown[]): unknown[] {
  const expansion = buildWorkerToolExpansionMap(tools)
  if (!expansion.size) return tools
  return tools.filter((raw) => {
    if (!isWorkerParentTool(raw)) return true
    const id = toolCallIdOf(raw as Record<string, unknown>)
    return !id || !expansion.has(id)
  })
}

/** Expand worker parent ids in filter / segment id lists to inner tool ids. */
export function expandWorkerFilterIds(filterIds: string[], tools: unknown[]): string[] {
  const expansion = buildWorkerToolExpansionMap(tools)
  return expandWorkerToolIdsInSegmentIds(filterIds, expansion)
}
