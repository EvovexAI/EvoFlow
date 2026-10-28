/**
 * Persist-layer caps for per-session chat rows.
 *
 * Orchestration runs push one DisplayRow per turn, each carrying full-copy
 * terminalStreams (500KB/tool) + subagentTasks snapshots + uncapped final text.
 * Rows lived forever in the session runtime → renderer OOM on long runs.
 * This module bounds that retention; see tests/session-rows-cap.test.js.
 */
import type { DisplayRow } from '../chat-types.js'
import { STREAM_ASSISTANT_BODY_CAP, capStreamTailText } from './stream-turn-engine.js'

/** Rows retained per session runtime (count cap; oldest dropped). */
export const SESSION_ROWS_MAX = 500

/** Rows (counted from the newest end) that keep heavy live snapshots. */
export const SESSION_ROWS_HEAVY_HORIZON = 30

/** Persisted per-tool output text cap (display layer truncates at 16KB; this guards retention). */
export const PERSIST_TOOL_OUTPUT_CAP = 65_536

/** Keep the tail of oversized persisted tool output; pass-through within cap. */
export function capPersistedToolOutput<T>(tool: T): T {
  const rec = tool as Record<string, unknown> | null
  if (!rec || typeof rec !== 'object') return tool
  const out = rec.output
  if (typeof out !== 'string' || out.length <= PERSIST_TOOL_OUTPUT_CAP) return tool
  return { ...rec, output: capStreamTailText(out, PERSIST_TOOL_OUTPUT_CAP) } as T
}

/**
 * Drop heavy live snapshots (terminalStreams / subagentTasks / _terminalData) from a
 * row and cap its tool outputs. History-shaped rows pass through reference-intact so
 * idempotent re-caps stay cheap.
 */
function lightenPersistedRow(row: DisplayRow): DisplayRow {
  if (!row || typeof row !== 'object') return row
  const tools = Array.isArray(row.tools) ? row.tools : null
  const hasHeavySnap = row.terminalStreams != null || row.subagentTasks != null
  const toolsNeedLight =
    tools != null &&
    tools.some((t) => {
      if (!t || typeof t !== 'object') return false
      const rec = t as Record<string, unknown>
      return (
        rec._terminalData != null ||
        (typeof rec.output === 'string' && rec.output.length > PERSIST_TOOL_OUTPUT_CAP)
      )
    })
  if (!hasHeavySnap && !toolsNeedLight) return row
  const next: DisplayRow = { ...row }
  if (hasHeavySnap) {
    delete next.terminalStreams
    delete next.subagentTasks
  }
  if (tools) {
    next.tools = tools.map((t) => {
      if (!t || typeof t !== 'object') return t
      const rec = t as Record<string, unknown>
      if (
        !('_terminalData' in rec) &&
        !(typeof rec.output === 'string' && rec.output.length > PERSIST_TOOL_OUTPUT_CAP)
      ) {
        return t
      }
      const { _terminalData: _drop, ...rest } = rec
      return capPersistedToolOutput(rest)
    })
  }
  return next
}

/**
 * Cap rows retained by a session runtime: keep only the newest SESSION_ROWS_MAX rows,
 * and strip heavy live snapshots from rows older than the heavy horizon (they stay on
 * the newest rows only — matching where the UI still renders live terminal/subagent panes).
 */
export function capSessionRows(rows: DisplayRow[]): DisplayRow[] {
  const list = Array.isArray(rows) ? rows : []
  if (!list.length) return list
  const trimmed = list.length > SESSION_ROWS_MAX ? list.slice(list.length - SESSION_ROWS_MAX) : list
  if (trimmed.length <= SESSION_ROWS_HEAVY_HORIZON) return trimmed
  const horizonStart = trimmed.length - SESSION_ROWS_HEAVY_HORIZON
  let changed = list.length !== trimmed.length
  const out = trimmed.map((row, i) => {
    if (i >= horizonStart) return row
    const light = lightenPersistedRow(row)
    if (light !== row) changed = true
    return light
  })
  return changed ? out : trimmed
}

/** Persisted final assistant text shares the live stream body cap. */
export function capPersistedRowText(text: string): string {
  return capStreamTailText(text, STREAM_ASSISTANT_BODY_CAP)
}
