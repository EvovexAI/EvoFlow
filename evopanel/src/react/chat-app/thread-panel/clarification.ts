/**
 * Clarification dock helpers derived from rows / thread panel state.
 * Extracted from ChatApp.tsx module-top helpers (P0).
 */
import {
  clarificationPreviewFromTool,
  isClarificationPreviewRenderable,
} from '../../lib/clarify-chat-display.js'
import {
  findAskClarificationAwaitingUserInRows,
  readAskClarificationInput,
} from '../../../lib/clarify-preview-resolve.js'
import {
  collectAssistantToolArraysFromRows,
  extractLastPlanToolSuccessFromArrays,
} from '../../../lib/collab-sidebar-from-tools.js'
import { isPlanExecutionConfirmationClarification } from '../../../lib/plan-exec-ui.js'
import { historyPastPlanExecutionGate } from '../../../lib/plan-pipeline.js'
import { rowHasVisibleContent } from '../../lib/display-row-content.js'
import type { DisplayRow, ThreadPanelState } from '../../chat-types.js'

export function parseClarificationFromTool(tool: unknown): { toolCallId?: string; preview?: string } | null {
  return clarificationPreviewFromTool(tool)
}

export function rowsHaveActionablePlan(rows: DisplayRow[]): boolean {
  if (!Array.isArray(rows) || !rows.length) return false
  if (historyPastPlanExecutionGate(rows)) return true
  const planHit = extractLastPlanToolSuccessFromArrays(collectAssistantToolArraysFromRows(rows))
  if (planHit?.boundPlanReady) return true
  if (planHit?.planInput) return true
  return false
}

export function extractLatestClarificationFromRows(
  rows: DisplayRow[],
): { toolCallId?: string; preview?: string } | null {
  if (!Array.isArray(rows) || !rows.length) return null
  if (rowsHaveActionablePlan(rows)) return null
  const awaiting = findAskClarificationAwaitingUserInRows(rows)
  if (!awaiting?.tool) return null
  const toolCallId =
    String(
      (awaiting.tool as { id?: string; tool_call_id?: string }).id ||
        (awaiting.tool as { tool_call_id?: string }).tool_call_id ||
        '',
    ).trim() || undefined
  const hit = parseClarificationFromTool(awaiting.tool)
  if (hit?.preview) {
    const input = readAskClarificationInput(awaiting.tool)
    if (isPlanExecutionConfirmationClarification(hit.preview, input)) return null
    return hit
  }
  if (!toolCallId) return null
  return { toolCallId }
}

export function clarificationPreviewReady(
  hit: { toolCallId?: string; preview?: string; content?: string } | null | undefined,
): boolean {
  const preview = String(hit?.preview || hit?.content || '').trim()
  return !!(preview && isClarificationPreviewRenderable(preview))
}

export function rowsAwaitUserReplyAfterSend(rows: DisplayRow[]): boolean {
  if (!Array.isArray(rows) || !rows.length) return false
  const last = rows[rows.length - 1]
  return last?.role === 'user' && rowHasVisibleContent(last)
}

export function mergeThreadPanelClarification(
  prev: { toolCallId?: string; preview?: string; content?: string } | null | undefined,
  restored: { toolCallId?: string; preview?: string } | null,
  opts?: { preferPrevWhileSending?: boolean; rowsHaveAwaitingAsk?: boolean },
): { toolCallId?: string; preview?: string } | null {
  const prevId = String(prev?.toolCallId || '').trim()
  const restoredId = String(restored?.toolCallId || '').trim()
  const prevReady = clarificationPreviewReady(prev)
  const restoredReady = clarificationPreviewReady(restored)
  const awaiting = !!opts?.rowsHaveAwaitingAsk

  if (restoredReady && restored) return restored
  if (awaiting && opts?.preferPrevWhileSending && prevReady && prev && (!restoredId || restoredId === prevId)) {
    return { toolCallId: prev.toolCallId, preview: prev.preview || prev.content }
  }
  if (awaiting && prevReady && prev && (!restoredId || restoredId === prevId)) {
    return { toolCallId: prev.toolCallId, preview: prev.preview || prev.content }
  }
  if (awaiting && restored?.toolCallId) return restored
  return null
}

export function clearThreadPanelClarification(prev: ThreadPanelState): ThreadPanelState {
  if (!prev.clarification) return prev
  return {
    ...prev,
    clarification: null,
    ...(String(prev.activityKind || '').toLowerCase() === 'clarification'
      ? { activityKind: 'idle' as const, activityDetail: '' }
      : {}),
  }
}

export function shouldSuppressClarificationPanel(rows: DisplayRow[], prev: ThreadPanelState): boolean {
  if (findAskClarificationAwaitingUserInRows(rows)) return false
  if (rowsHaveActionablePlan(rows)) return true
  if (
    String(prev.collabPhase || '')
      .trim()
      .toLowerCase() === 'plan_ready'
  ) {
    return true
  }
  if (prev.collabTask?.boundPlanReady) return true
  return false
}
