import { getToolInputObjectFromRow } from '../lib/chat-normalize.js'
import { resolveToolKey } from '../lib/tool-display.js'

export type FileDiffSegment = { text: string; changed: boolean }

export type FileDiffRow = {
  kind: 'context' | 'add' | 'remove'
  text: string
  /** Intra-line highlight for paired edit rows */
  segments?: FileDiffSegment[]
}

export type FileDiffView = {
  added: number
  removed: number
  rows: FileDiffRow[]
  /** Set when diff rows or LCS input were capped for UI performance */
  truncated?: string
}

/** Max lines fed to LCS per file side (avoids O(n×m) blow-ups on large files). */
export const MAX_DIFF_LCS_LINES_PER_SIDE = 250
/** Max diff rows rendered in the chat panel (scroll area still virtualizes above this). */
export const MAX_DIFF_RENDER_ROWS = 200
/** Max lines per side for fragment (old_string/new_string) diffs. */
export const MAX_FRAGMENT_DIFF_LINES_PER_SIDE = 80
/** Max lines for write-preview rows (unchanged default for buildWriteAddedRows). */
export const MAX_WRITE_PREVIEW_LINES = 64

type DiffOp = { t: 'eq' | 'ins' | 'del'; line: string }

function splitLines(text: string): string[] {
  if (!text) return []
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
}

function mergeTruncated(prev: string | undefined, next: string): string {
  return prev ? `${prev}；${next}` : next
}

function capLineArray(lines: string[], max: number): { lines: string[]; truncated?: string } {
  if (lines.length <= max) return { lines }
  return {
    lines: lines.slice(0, max),
    truncated: `仅基于前 ${max} 行计算 diff（共 ${lines.length} 行）`,
  }
}

function capRowsForRender(view: FileDiffView, maxRows = MAX_DIFF_RENDER_ROWS): FileDiffView {
  if (view.rows.length <= maxRows) return view
  const omitted = view.rows.length - maxRows
  return {
    ...view,
    rows: [
      ...view.rows.slice(0, maxRows),
      { kind: 'context', text: `… 还有 ${omitted} 行未显示` },
    ],
    truncated: mergeTruncated(view.truncated, `仅显示前 ${maxRows} 行`),
  }
}

function diffLineOps(before: string[], after: string[]): DiffOp[] {
  const n = before.length
  const m = after.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        before[i] === after[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ t: 'eq', line: before[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: 'del', line: before[i] })
      i++
    } else {
      ops.push({ t: 'ins', line: after[j] })
      j++
    }
  }
  while (i < n) {
    ops.push({ t: 'del', line: before[i++] })
  }
  while (j < m) {
    ops.push({ t: 'ins', line: after[j++] })
  }
  return ops
}

function statsFromOps(ops: DiffOp[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const op of ops) {
    if (op.t === 'ins') added++
    if (op.t === 'del') removed++
  }
  return { added, removed }
}

function opToRow(op: DiffOp): FileDiffRow {
  if (op.t === 'eq') return { kind: 'context', text: op.line }
  if (op.t === 'del') return { kind: 'remove', text: op.line }
  return { kind: 'add', text: op.line }
}

/** Highlight changed middle of adjacent remove/add line pairs (IDE inline diff). */
export function pairInlineSegments(
  removeText: string,
  addText: string,
): { remove: FileDiffSegment[]; add: FileDiffSegment[] } {
  let pre = 0
  const minLen = Math.min(removeText.length, addText.length)
  while (pre < minLen && removeText[pre] === addText[pre]) pre++
  let suf = 0
  while (
    suf < removeText.length - pre &&
    suf < addText.length - pre &&
    removeText[removeText.length - 1 - suf] === addText[addText.length - 1 - suf]
  ) {
    suf++
  }
  const removeEnd = removeText.length - suf
  const addEnd = addText.length - suf
  const removeSegs: FileDiffSegment[] = []
  const addSegs: FileDiffSegment[] = []
  if (pre > 0) {
    removeSegs.push({ text: removeText.slice(0, pre), changed: false })
    addSegs.push({ text: addText.slice(0, pre), changed: false })
  }
  const removeMid = removeText.slice(pre, removeEnd)
  const addMid = addText.slice(pre, addEnd)
  if (removeMid) removeSegs.push({ text: removeMid, changed: true })
  if (addMid) addSegs.push({ text: addMid, changed: true })
  if (suf > 0) {
    removeSegs.push({ text: removeText.slice(removeEnd), changed: false })
    addSegs.push({ text: addText.slice(addEnd), changed: false })
  }
  if (!removeSegs.length) removeSegs.push({ text: removeText, changed: true })
  if (!addSegs.length) addSegs.push({ text: addText, changed: true })
  return { remove: removeSegs, add: addSegs }
}

export function enrichRowsWithInlineSegments(rows: FileDiffRow[]): FileDiffRow[] {
  const out: FileDiffRow[] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const next = rows[i + 1]
    if (row.kind === 'remove' && next?.kind === 'add') {
      const paired = pairInlineSegments(row.text, next.text)
      out.push({ ...row, segments: paired.remove })
      out.push({ ...next, segments: paired.add })
      i++
      continue
    }
    if (row.kind === 'add' || row.kind === 'remove') {
      out.push(row)
      continue
    }
    out.push(row)
  }
  return out
}

/** Line diff with ±N stats and 1–2 unchanged context lines around each hunk. */
export function buildContextualFileDiff(
  beforeText: string | undefined,
  afterText: string | undefined,
  contextLines = 2,
): FileDiffView {
  const beforeRaw = splitLines(beforeText ?? '')
  const afterRaw = splitLines(afterText ?? '')
  const beforeCap = capLineArray(beforeRaw, MAX_DIFF_LCS_LINES_PER_SIDE)
  const afterCap = capLineArray(afterRaw, MAX_DIFF_LCS_LINES_PER_SIDE)
  const before = beforeCap.lines
  const after = afterCap.lines
  const truncated = beforeCap.truncated || afterCap.truncated

  const ops = diffLineOps(before, after)
  const { added, removed } = statsFromOps(ops)
  const changeMask = ops.map((op) => op.t !== 'eq')
  if (!changeMask.some(Boolean)) {
    return { added, removed, rows: [], ...(truncated ? { truncated } : {}) }
  }

  const rows: FileDiffRow[] = []
  let cursor = 0
  while (cursor < ops.length) {
    while (cursor < ops.length && !changeMask[cursor]) cursor++
    if (cursor >= ops.length) break

    const changeStart = cursor
    while (cursor < ops.length && changeMask[cursor]) cursor++
    const changeEnd = cursor - 1

    const emitStart = Math.max(0, changeStart - contextLines)
    let emitEnd = changeEnd
    let trailingCtx = 0
    while (
      emitEnd + 1 < ops.length &&
      ops[emitEnd + 1].t === 'eq' &&
      trailingCtx < contextLines
    ) {
      emitEnd++
      trailingCtx++
    }

    for (let k = emitStart; k <= emitEnd; k++) {
      rows.push(opToRow(ops[k]))
    }
  }

  return capRowsForRender({
    added,
    removed,
    rows: enrichRowsWithInlineSegments(rows),
    ...(truncated ? { truncated } : {}),
  })
}

/** Fallback when only replace fragments are known (no full file snapshot). */
export function buildFragmentFileDiff(
  oldString: string | undefined,
  newString: string | undefined,
): FileDiffView {
  const oldCap = capLineArray(splitLines(oldString ?? ''), MAX_FRAGMENT_DIFF_LINES_PER_SIDE)
  const newCap = capLineArray(splitLines(newString ?? ''), MAX_FRAGMENT_DIFF_LINES_PER_SIDE)
  const oldLines = oldCap.lines
  const newLines = newCap.lines
  const truncated = oldCap.truncated || newCap.truncated
  const rows: FileDiffRow[] = [
    ...oldLines.map((text) => ({ kind: 'remove' as const, text })),
    ...newLines.map((text) => ({ kind: 'add' as const, text })),
  ]
  return capRowsForRender({
    added: splitLines(newString ?? '').length,
    removed: splitLines(oldString ?? '').length,
    rows: enrichRowsWithInlineSegments(rows),
    ...(truncated ? { truncated } : {}),
  })
}

/** Show current file text as neutral context lines when there is no +/- hunk. */
export function buildFileSnapshotRows(content: string | undefined, maxLines = 32): FileDiffRow[] {
  const lines = splitLines(content ?? '')
  const capped = lines.length > maxLines ? lines.slice(0, maxLines) : lines
  return capped.map((text) => ({ kind: 'context', text }))
}

/** Write preview: every line shown as an addition (green in terminal diff UI). */
export function buildWriteAddedRows(
  content: string | undefined,
  maxLines = MAX_WRITE_PREVIEW_LINES,
): FileDiffView {
  const lines = splitLines(content ?? '')
  const cap = capLineArray(lines, maxLines)
  return capRowsForRender({
    added: lines.length,
    removed: 0,
    rows: enrichRowsWithInlineSegments(cap.lines.map((text) => ({ kind: 'add' as const, text }))),
    ...(cap.truncated ? { truncated: cap.truncated } : {}),
  })
}

/** Lightweight +/- line counts for tool list summaries (no diff rows). */
export function computeFileEditDiffStats(input: {
  action: string
  content?: string
  old_string?: string
  new_string?: string
  before_content?: string
  after_content?: string
}): { added: number; removed: number } {
  const act = String(input.action || '').trim().toLowerCase()
  if (act === 'delete') return { added: 0, removed: 0 }

  if (input.before_content != null || input.after_content != null) {
    const beforeCap = capLineArray(splitLines(input.before_content ?? ''), MAX_DIFF_LCS_LINES_PER_SIDE)
    const afterCap = capLineArray(splitLines(input.after_content ?? ''), MAX_DIFF_LCS_LINES_PER_SIDE)
    const ops = diffLineOps(beforeCap.lines, afterCap.lines)
    const stats = statsFromOps(ops)
    if (act === 'write' && !stats.removed && input.after_content) {
      return { added: splitLines(input.after_content).length, removed: 0 }
    }
    return stats
  }

  if (act === 'write' && input.content) {
    return { added: splitLines(input.content).length, removed: 0 }
  }

  if ((act === 'replace' || act === 'edit') && (input.old_string || input.new_string)) {
    return {
      added: splitLines(input.new_string ?? '').length,
      removed: splitLines(input.old_string ?? '').length,
    }
  }

  return { added: 0, removed: 0 }
}

export function formatFileEditDiffStatBrief(
  stats: { added: number; removed: number },
  action?: string,
): string {
  const act = String(action || '').trim().toLowerCase()
  if (act === 'delete') return ''
  const parts: string[] = []
  if (stats.added > 0) parts.push(`+${stats.added}`)
  if (stats.removed > 0) parts.push(`−${stats.removed}`)
  return parts.join(' ')
}

export function fileEditActionFromToolKind(toolKind: string): string {
  const k = String(toolKind || '').trim().toLowerCase()
  if (k === 'delete' || k === 'delete_file') return 'delete'
  if (k === 'write' || k === 'write_file' || k === 'write_to_file') return 'write'
  return 'replace'
}

export function isFileEditStatToolKind(toolKind: string): boolean {
  const k = String(toolKind || '').trim().toLowerCase()
  return (
    k === 'write' ||
    k === 'replace' ||
    k === 'write_file' ||
    k === 'str_replace' ||
    k === 'write_to_file' ||
    k === 'replace_in_file' ||
    k === 'delete' ||
    k === 'delete_file'
  )
}

/** 单条工具行的 +/- 统计（与 ToolCallList 展示逻辑对齐） */
export function fileEditStatsFromTool(tool: unknown): { added: number; removed: number } | null {
  const t = tool as Record<string, unknown>
  const toolKind = resolveToolKey(t)
  if (!isFileEditStatToolKind(toolKind)) return null
  const action = fileEditActionFromToolKind(toolKind)
  if (action === 'delete') return null

  const writeProgress =
    t._writeProgress && typeof t._writeProgress === 'object'
      ? (t._writeProgress as {
          phase?: string
          lines_added?: number
          lines_removed?: number
          content?: string
          old_string?: string
          new_string?: string
        })
      : null
  if (writeProgress) {
    const added = Number(writeProgress.lines_added) || 0
    const removed = Number(writeProgress.lines_removed) || 0
    const phase = String(writeProgress.phase || '').trim().toLowerCase()
    const phaseIsFinal = phase === 'writing' || phase === 'done' || phase === 'error'
    // Final disk phases always win (including 0/0 same-length replace).
    if (phaseIsFinal || added || removed) return { added, removed }
  }

  const inputObj = getToolInputObjectFromRow(t) as Record<string, unknown> | null
  const content =
    (typeof writeProgress?.content === 'string' && writeProgress.content) ||
    (typeof inputObj?.content === 'string' ? inputObj.content : undefined)
  const old_string =
    (typeof writeProgress?.old_string === 'string' && writeProgress.old_string) ||
    (typeof inputObj?.old_string === 'string' ? inputObj.old_string : undefined)
  const new_string =
    (typeof writeProgress?.new_string === 'string' && writeProgress.new_string) ||
    (typeof inputObj?.new_string === 'string' ? inputObj.new_string : undefined)
  if (!content && !old_string && !new_string && !inputObj) return null
  const stats = computeFileEditDiffStats({
    action,
    content,
    old_string,
    new_string,
    before_content: typeof inputObj?.before_content === 'string' ? inputObj.before_content : undefined,
    after_content: typeof inputObj?.after_content === 'string' ? inputObj.after_content : undefined,
  })
  if (!stats.added && !stats.removed) return null
  return stats
}

/** 整轮 assistant turn 内所有文件变更工具的 +/- 累加 */
export function accumulateFileEditStatsFromTools(tools: unknown[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const tool of tools || []) {
    const stats = fileEditStatsFromTool(tool)
    if (!stats) continue
    added += stats.added
    removed += stats.removed
  }
  return { added, removed }
}

export function resolveWorkerFileDiffView(input: {
  action: string
  content?: string
  old_string?: string
  new_string?: string
  before_content?: string
  after_content?: string
}): FileDiffView | null {
  const act = String(input.action || '').trim().toLowerCase()
  const isWrite = act === 'write'
  const isReplace = act === 'replace'
  const isEdit = act === 'edit'

  if (input.before_content != null || input.after_content != null) {
    const view = buildContextualFileDiff(input.before_content, input.after_content, 2)
    if (view.rows.length) return view
    const afterText = input.after_content ?? input.before_content ?? ''
    if (isWrite && afterText) return buildWriteAddedRows(afterText)
    const snapshot = buildFileSnapshotRows(afterText)
    if (snapshot.length) return { ...view, rows: snapshot }
    return view
  }

  if (isWrite && input.content) {
    const view = buildContextualFileDiff('', input.content, 2)
    if (view.rows.length) return view
    return buildWriteAddedRows(input.content)
  }

  if ((isReplace || isEdit) && (input.old_string || input.new_string)) {
    const view = buildFragmentFileDiff(input.old_string, input.new_string)
    if (view.rows.length) return view
    if (input.new_string) return buildWriteAddedRows(input.new_string)
    return view
  }

  return null
}
