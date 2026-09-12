import type { DisplayRow } from '../chat-types.js'
import { assistantPlainForTurnStrip } from './turn-text-isolation.js'

export type ReconcileLastAssistantResult =
  | { status: 'applied'; rows: DisplayRow[] }
  | { status: 'synced' }
  | { status: 'retry'; reason: string }
  | { status: 'skip'; reason: string }

function collectToolIds(tools: unknown[] | undefined): string[] {
  const out: string[] = []
  for (const raw of tools || []) {
    if (!raw || typeof raw !== 'object') continue
    const t = raw as { id?: string; tool_call_id?: string }
    const id = String(t.id || t.tool_call_id || '').trim()
    if (id) out.push(id)
  }
  return out.sort()
}

function toolStatusSignature(tools: unknown[] | undefined): string {
  const parts: string[] = []
  for (const raw of tools || []) {
    if (!raw || typeof raw !== 'object') continue
    const t = raw as { id?: string; tool_call_id?: string; status?: string }
    const id = String(t.id || t.tool_call_id || '').trim()
    if (!id) continue
    parts.push(`${id}:${String(t.status || '').trim().toLowerCase()}`)
  }
  return parts.sort().join(',')
}

function assistantRowsNeedDbMerge(localRow: DisplayRow, dbRow: DisplayRow): boolean {
  if (localRow.incompleteStream === true && dbRow.incompleteStream !== true) return true
  if (toolStatusSignature(localRow.tools) !== toolStatusSignature(dbRow.tools)) return true
  // 本地只有 plan+tools、DB 已有工具后总结时强制用 DB（RUN_FINISHED 丢 END 的常见残态）
  if (
    segmentHasPostToolText(dbRow.segments) &&
    !segmentHasPostToolText(localRow.segments) &&
    assistantPlainForTurnStrip(dbRow).trim().length >
      assistantPlainForTurnStrip(localRow).trim().length
  ) {
    return true
  }
  return false
}

function segmentHasPostToolText(segments: DisplayRow['segments']): boolean {
  const list = Array.isArray(segments) ? segments : []
  let lastTools = -1
  for (let i = 0; i < list.length; i++) {
    if (list[i]?.kind === 'tools') lastTools = i
  }
  if (lastTools < 0) return false
  return list
    .slice(lastTools + 1)
    .some((s) => s?.kind === 'text' && String((s as { text?: string }).text || '').trim())
}

function assistantRowHasPersistedContent(row: DisplayRow | undefined): boolean {
  if (!row || row.role !== 'assistant') return false
  return !!(
    String(row.text || '').trim() ||
    row.segments?.length ||
    row.tools?.length
  )
}

function comparableAssistantSignature(row: DisplayRow | undefined): string {
  if (!row || row.role !== 'assistant') return ''
  const body = assistantPlainForTurnStrip(row)
  const segCount = row.segments?.length || 0
  const toolIds = collectToolIds(row.tools).join(',')
  const incomplete = row.incompleteStream === true ? '1' : '0'
  return `${body}\x1f${segCount}\x1f${toolIds}\x1f${toolStatusSignature(row.tools)}\x1f${incomplete}`
}

/** 最后一条 user 之后、可选按 runId 匹配的 assistant 行下标。 */
export function findAssistantIndexAfterLastUser(
  rows: DisplayRow[],
  runId?: string | null,
): number {
  let lastUserIdx = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]?.role === 'user') {
      lastUserIdx = i
      break
    }
  }
  const rid = String(runId || '').trim()
  if (rid) {
    for (let i = rows.length - 1; i > lastUserIdx; i--) {
      if (rows[i]?.role === 'assistant' && String(rows[i].runId || '').trim() === rid) return i
    }
  }
  for (let i = rows.length - 1; i > lastUserIdx; i--) {
    if (rows[i]?.role === 'assistant') return i
  }
  return -1
}

function mergeDbAssistantOverLocal(localRow: DisplayRow, dbRow: DisplayRow, runId?: string | null): DisplayRow {
  return {
    ...dbRow,
    role: 'assistant',
    runId: dbRow.runId || localRow.runId || runId || undefined,
    durationStr: dbRow.durationStr || localRow.durationStr,
    tokenStr: dbRow.tokenStr || localRow.tokenStr,
    subagentTasks: dbRow.subagentTasks || localRow.subagentTasks,
    terminalStreams: dbRow.terminalStreams || localRow.terminalStreams,
  }
}

/** 用 DB 最后一轮 assistant 替换本地对应行（不整页 reload，避免 loading 闪烁）。 */
export function reconcileLastAssistantInRows(
  localRows: DisplayRow[],
  dbRows: DisplayRow[],
  runId?: string | null,
): ReconcileLastAssistantResult {
  if (!localRows.length || !dbRows.length) {
    return { status: 'retry', reason: 'empty_rows' }
  }
  const localIdx = findAssistantIndexAfterLastUser(localRows, runId)
  if (localIdx < 0) return { status: 'skip', reason: 'no_local_assistant' }
  const dbIdx = findAssistantIndexAfterLastUser(dbRows, runId)
  if (dbIdx < 0) return { status: 'retry', reason: 'no_db_assistant' }
  const dbRow = dbRows[dbIdx]
  if (!assistantRowHasPersistedContent(dbRow)) {
    return { status: 'retry', reason: 'db_assistant_empty' }
  }
  const localRow = localRows[localIdx]
  const merged = mergeDbAssistantOverLocal(localRow, dbRow, runId)
  if (assistantRowsNeedDbMerge(localRow, merged)) {
    const localBody = assistantPlainForTurnStrip(localRow).trim()
    const mergedBody = assistantPlainForTurnStrip(merged).trim()
    if (localBody.length > mergedBody.length + 32 && mergedBody) {
      return { status: 'synced' }
    }
    const out = [...localRows]
    out[localIdx] = merged
    for (let i = out.length - 1; i > localIdx; i--) {
      if (out[i]?.role === 'assistant') out.splice(i, 1)
    }
    return { status: 'applied', rows: out }
  }
  const localBody = assistantPlainForTurnStrip(localRow).trim()
  const mergedBody = assistantPlainForTurnStrip(merged).trim()
  if (localBody && mergedBody && localBody === mergedBody) {
    return { status: 'synced' }
  }
  if (comparableAssistantSignature(localRow) === comparableAssistantSignature(merged)) {
    return { status: 'synced' }
  }
  if (localBody.length > mergedBody.length + 32 && mergedBody) {
    return { status: 'synced' }
  }
  const out = [...localRows]
  out[localIdx] = merged
  for (let i = out.length - 1; i > localIdx; i--) {
    if (out[i]?.role === 'assistant') out.splice(i, 1)
  }
  return { status: 'applied', rows: out }
}

/**
 * dbOnly 历史刷新：DB 未落库时保留本地 incomplete assistant，避免目标判断期间正文闪没。
 */
export function mergeDbOnlyHistoryRows(
  localRows: DisplayRow[],
  dbRows: DisplayRow[],
  runId?: string | null,
  forceDb?: boolean,
): DisplayRow[] {
  if (!localRows.length) return dbRows
  if (!dbRows.length) return localRows
  const outcome = reconcileLastAssistantInRows(localRows, dbRows, runId)
  if (outcome.status === 'applied') return outcome.rows
  if (outcome.status === 'synced') return forceDb ? dbRows : localRows
  const localIdx = findAssistantIndexAfterLastUser(localRows, runId)
  if (localIdx < 0) return dbRows
  const localRow = localRows[localIdx]
  if (localRow.incompleteStream === true && assistantRowHasPersistedContent(localRow)) {
    return localRows
  }
  return dbRows
}

/** True when reconcile output would not change visible transcript. */
export function displayRowsEquivalent(a: DisplayRow[], b: DisplayRow[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const left = a[i]
    const right = b[i]
    if (!left || !right || left.role !== right.role) return false
    if (left.role === 'assistant') {
      if (comparableAssistantSignature(left) !== comparableAssistantSignature(right)) return false
      continue
    }
    if (String(left.text || '') !== String(right.text || '')) return false
  }
  return true
}
