/**
 * Fold multiple assistant bubbles after the same real user into one.
 * Mid-turn tool rounds sometimes seal as a completed row; final then appends
 * another — history and live UI must show a single delivery bubble.
 */
import type { DisplayRow } from '../chat-types.js'
import { mergeToolsForPlanDetection } from '../../lib/plan-pipeline.js'
import { isHiddenToolApprovalUserMessage } from '../../lib/tool-approval.js'
import { mergeAssistantRowWithStreamRow } from './merge-assistant-stream-row.js'
import { chatRunIdsSameTurn } from './run-turn-gate.js'

export function segmentHasPostToolText(segments: DisplayRow['segments']): boolean {
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

function toolIdSet(tools: unknown[] | undefined): Set<string> {
  const out = new Set<string>()
  for (const raw of tools || []) {
    if (!raw || typeof raw !== 'object') continue
    const t = raw as { id?: string; tool_call_id?: string }
    const id = String(t.id || t.tool_call_id || '').trim()
    if (id) out.add(id)
  }
  return out
}

/** Sealed mid-tool exploring row: tools/旁白 but no post-tool final reply. */
export function assistantLooksMidTurnPartial(row: DisplayRow | undefined): boolean {
  if (!row || row.role !== 'assistant') return false
  if (row.incompleteStream === true) return true
  const toolsLen = Array.isArray(row.tools) ? row.tools.length : 0
  if (toolsLen <= 0) return false
  // Exploring / tool rounds without a final summary after the last tools segment.
  return !segmentHasPostToolText(row.segments)
}

export function sameTurnAssistantRunsMatch(
  a: DisplayRow | undefined,
  b: DisplayRow | undefined,
): boolean {
  const ra = String(a?.runId || '').trim()
  const rb = String(b?.runId || '').trim()
  if (!ra || !rb) return true
  return ra === rb || chatRunIdsSameTurn(ra, rb)
}

/** Earlier tools are a subset of later — classic mid-seal then final. */
export function earlierToolsSubsetOfLater(
  earlier: DisplayRow | undefined,
  later: DisplayRow | undefined,
): boolean {
  const a = toolIdSet(earlier?.tools)
  const b = toolIdSet(later?.tools)
  if (!a.size) return (b.size > 0 || !!String(later?.text || '').trim())
  if (!b.size) return false
  for (const id of a) {
    if (!b.has(id)) return false
  }
  return b.size >= a.size
}

export function shouldCollapseSameTurnAssistants(
  earlier: DisplayRow,
  later: DisplayRow,
): boolean {
  if (earlier.role !== 'assistant' || later.role !== 'assistant') return false
  if (!sameTurnAssistantRunsMatch(earlier, later)) return false
  if (assistantLooksMidTurnPartial(earlier)) return true
  if (earlierToolsSubsetOfLater(earlier, later)) return true
  return false
}

function mergeAssistantPair(a: DisplayRow, b: DisplayRow): DisplayRow {
  const merged = mergeAssistantRowWithStreamRow(
    { ...a, incompleteStream: true },
    b,
  )
  const keepIncomplete = b.incompleteStream === true || a.incompleteStream === true
  const withTools: DisplayRow = {
    ...merged,
    tools: mergeToolsForPlanDetection(a.tools || [], b.tools || []),
    durationStr: b.durationStr || a.durationStr,
    tokenStr: b.tokenStr || a.tokenStr,
    runId: b.runId || a.runId,
  }
  if (keepIncomplete) {
    return {
      ...withTools,
      incompleteStream: true,
      durationStr: undefined,
      tokenStr: undefined,
    }
  }
  const { incompleteStream: _drop, ...rest } = withTools as DisplayRow & {
    incompleteStream?: boolean
  }
  return rest
}

/**
 * Within each real-user turn, fold assistant fragments that belong to the same
 * multi-tool run into a single DisplayRow (keeps hidden approval user rows out).
 *
 * Also folds a leading orphan assistant run at the list head (common when a
 * history page starts mid-turn before its user message has been loaded, or
 * after older+newer pages are concatenated).
 */
export function collapseSameTurnAssistantsInRows(rows: DisplayRow[]): DisplayRow[] {
  if (!Array.isArray(rows) || rows.length < 2) return rows

  const out: DisplayRow[] = []
  let i = 0

  // Leading assistants before the first real user (page-seam / mid-turn cut).
  {
    const leadAssistants: DisplayRow[] = []
    const leadOthers: DisplayRow[] = []
    while (i < rows.length) {
      const next = rows[i]
      if (
        next?.role === 'user' &&
        !isHiddenToolApprovalUserMessage(String(next.text || ''))
      ) {
        break
      }
      if (next?.role === 'assistant') leadAssistants.push(next)
      else if (
        next?.role === 'user' &&
        isHiddenToolApprovalUserMessage(String(next.text || ''))
      ) {
        /* drop */
      } else if (next) {
        leadOthers.push(next)
      }
      i += 1
    }
    if (leadAssistants.length > 1) {
      let shouldFold = false
      for (let j = 0; j < leadAssistants.length - 1; j++) {
        if (
          shouldCollapseSameTurnAssistants(leadAssistants[j], leadAssistants[j + 1]) ||
          shouldCollapseSameTurnAssistants(leadAssistants[j], leadAssistants[leadAssistants.length - 1])
        ) {
          shouldFold = true
          break
        }
      }
      if (shouldFold) {
        let merged = leadAssistants[0]
        for (let j = 1; j < leadAssistants.length; j++) {
          merged = mergeAssistantPair(merged, leadAssistants[j])
        }
        if (merged.incompleteStream !== true) {
          const { incompleteStream: _drop, ...rest } = merged as DisplayRow & {
            incompleteStream?: boolean
          }
          merged = rest
        }
        out.push(merged)
      } else {
        for (const a of leadAssistants) out.push(a)
      }
    } else {
      for (const a of leadAssistants) out.push(a)
    }
    for (const o of leadOthers) out.push(o)
  }

  while (i < rows.length) {
    const row = rows[i]
    out.push(row)
    i += 1
    if (row?.role !== 'user' || isHiddenToolApprovalUserMessage(String(row.text || ''))) {
      continue
    }

    const turnStart = out.length
    const turnAssistants: DisplayRow[] = []
    const turnOthers: DisplayRow[] = []
    while (i < rows.length) {
      const next = rows[i]
      if (
        next?.role === 'user' &&
        !isHiddenToolApprovalUserMessage(String(next.text || ''))
      ) {
        break
      }
      if (next?.role === 'assistant') turnAssistants.push(next)
      else if (
        next?.role === 'user' &&
        isHiddenToolApprovalUserMessage(String(next.text || ''))
      ) {
        /* drop hidden approval replay from between assistants */
      } else if (next) {
        turnOthers.push(next)
      }
      i += 1
    }

    if (turnAssistants.length <= 1) {
      for (const a of turnAssistants) out.push(a)
      for (const o of turnOthers) out.push(o)
      continue
    }

    let shouldFold = false
    for (let j = 0; j < turnAssistants.length - 1; j++) {
      if (shouldCollapseSameTurnAssistants(turnAssistants[j], turnAssistants[j + 1])) {
        shouldFold = true
        break
      }
      if (shouldCollapseSameTurnAssistants(turnAssistants[j], turnAssistants[turnAssistants.length - 1])) {
        shouldFold = true
        break
      }
    }

    if (!shouldFold) {
      for (const a of turnAssistants) out.push(a)
      for (const o of turnOthers) out.push(o)
      continue
    }

    let merged = turnAssistants[0]
    for (let j = 1; j < turnAssistants.length; j++) {
      merged = mergeAssistantPair(merged, turnAssistants[j])
    }
    if (merged.incompleteStream !== true) {
      const { incompleteStream: _drop, ...rest } = merged as DisplayRow & {
        incompleteStream?: boolean
      }
      merged = rest
    }
    // Replace the trailing user placeholder slot content for this turn
    out.length = turnStart
    out.push(merged)
    for (const o of turnOthers) out.push(o)
  }

  return out
}

/** Whether final commit should merge into a completed mid-turn exploring row. */
export function shouldMergeFinalIntoPriorAssistant(
  prior: DisplayRow | undefined,
  next: DisplayRow,
  sealRunId?: string | null,
): boolean {
  if (!prior || prior.role !== 'assistant') return false
  if (prior.incompleteStream === true) return true
  const priorRun = String(prior.runId || '').trim()
  const seal = String(sealRunId || next.runId || '').trim()
  if (priorRun && seal && (priorRun === seal || chatRunIdsSameTurn(priorRun, seal))) {
    return true
  }
  if (assistantLooksMidTurnPartial(prior)) return true
  if (earlierToolsSubsetOfLater(prior, next)) return true
  return false
}
