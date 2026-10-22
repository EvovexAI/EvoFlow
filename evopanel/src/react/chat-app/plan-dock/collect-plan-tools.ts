/**
 * Collect tools used for plan detection (stream vs history).
 * Extracted from ChatApp.tsx (P15).
 */
import type { MutableRefObject } from 'react'
import {
  mergePlanToolsForDetection,
  mergeToolsForPlanDetection,
  enrichToolsWithCachedPlanInput,
} from '../../../lib/plan-pipeline.js'
import {
  mergeAssistantToolsFromRows,
  toolsFromLastAssistantRow,
} from '../../../lib/collab-sidebar-from-tools.js'
import type { StreamState } from '../../chat-types.js'

/** Minimal row shape needed for tool extraction */
type ToolRow = { role?: string; tools?: unknown[] }

export type CollectPlanToolsCtx = {
  streamRef: MutableRefObject<StreamState>
  persistedPlanInputRef: MutableRefObject<Record<string, unknown> | null>
  lastPlanDetectionToolsRef: MutableRefObject<unknown[]>
  streamRefHasVisibleContent: (stream: StreamState) => boolean
}

/** 底部 plan 条：流式中仅用 stream buffer，避免全历史合并冲掉当前 plan。 */
export function collectPlanToolsForDetection(
  ctx: CollectPlanToolsCtx,
  rows: ToolRow[],
  selectedTurnBusy: boolean,
): unknown[] {
  const streamTools = ctx.streamRef.current.turn.tools as unknown[]
  const rowTools = toolsFromLastAssistantRow(rows)
  const historyTools = mergeAssistantToolsFromRows(rows)
  const streamActive =
    Array.isArray(streamTools) &&
    streamTools.length > 0 &&
    (selectedTurnBusy || ctx.streamRefHasVisibleContent(ctx.streamRef.current))
  const persisted = ctx.persistedPlanInputRef.current
  const enrich = (list: unknown[]) =>
    enrichToolsWithCachedPlanInput(list, persisted ? { planInput: persisted } : null)
  // 流式进行中只用当前轮 stream buffer，避免上一轮 8～9 个工具行把 plan 冲没（plan=0 hit=none）
  if (streamActive) {
    return enrich(mergePlanToolsForDetection(streamTools, rowTools, true))
  }
  const snap = ctx.lastPlanDetectionToolsRef.current
  if (Array.isArray(snap) && snap.length > 0 && rows.length > 0) {
    return enrich(mergeToolsForPlanDetection(snap, historyTools, rowTools))
  }
  if (!rows.length) {
    return enrich([])
  }
  return enrich(mergeToolsForPlanDetection(historyTools, rowTools))
}
