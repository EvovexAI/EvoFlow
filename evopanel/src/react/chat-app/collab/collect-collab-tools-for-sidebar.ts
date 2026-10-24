/**
 * Merge stream + history assistant tools for the collab sidebar.
 * Extracted from ChatApp.tsx (P41).
 */
import type { MutableRefObject, RefObject } from 'react'
import type { DisplayRow, StreamState } from '../../chat-types.js'
import { mergeAssistantToolsFromRows } from '../../../lib/collab-sidebar-from-tools.js'
import { mergePlanToolsForDetection } from '../../../lib/plan-pipeline.js'

export type CollectCollabToolsForSidebarCtx = {
  streamRef: RefObject<StreamState> | MutableRefObject<StreamState>
}

export function collectCollabToolsForSidebar(
  ctx: CollectCollabToolsForSidebarCtx,
  rows: DisplayRow[],
): unknown[] {
  const streamTools = ctx.streamRef.current.turn.tools as unknown[]
  const rowTools = mergeAssistantToolsFromRows(rows)
  return mergePlanToolsForDetection(
    Array.isArray(streamTools) ? streamTools : [],
    rowTools,
    false,
  )
}
