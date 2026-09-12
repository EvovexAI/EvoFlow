import type { ActivityPiece } from './exploring-activity-group.js'
import { reasoningPiecesInActivity } from './exploring-activity-group.js'

/** 思考展示策略：顶栏堆叠 vs 时间线 inline（按 activity 批次） */
export type ReasoningDisplayPlan = {
  /** 仅在无 segments 时间线时的兜底（如仅有 reasoningPreview） */
  showTopStack: boolean
  /** 与 Exploring 交错：思考进 displayChunks，不在顶栏重复 */
  useTimelineInterleave: boolean
}

export function resolveReasoningDisplayPlan(opts: {
  isStreaming: boolean
  hasTimelineReasoning: boolean
  hasVisibleToolsInTimeline: boolean
  hasToolsSegmentInTimeline: boolean
  hasToolsInTurnEarly: boolean
  displaySegmentCount: number
}): ReasoningDisplayPlan {
  const useTimelineInterleave =
    opts.hasVisibleToolsInTimeline &&
    (opts.hasTimelineReasoning || opts.hasToolsSegmentInTimeline)

  const reasoningInDisplayTimeline =
    opts.hasTimelineReasoning && opts.displaySegmentCount > 0

  const showTopStack =
    !shouldSuppressTopReasoningBlocks(
      useTimelineInterleave,
      opts.hasToolsInTurnEarly,
      reasoningInDisplayTimeline,
      opts.isStreaming,
    ) && !(opts.isStreaming && opts.displaySegmentCount > 0)

  return { showTopStack, useTimelineInterleave }
}

/**
 * 时间线含 reasoning 时一律 inline（流式/历史相同），避免顶栏堆叠全部思考段。
 * 流式期间另有工具轮次抑制，防止与 Exploring 重复。
 */
export function shouldSuppressTopReasoningBlocks(
  useTimelineReasoningUi: boolean,
  hasToolsInTurnEarly: boolean,
  reasoningInDisplayTimeline = false,
  isStreaming = false,
): boolean {
  if (reasoningInDisplayTimeline) return true
  if (!isStreaming) return false
  return useTimelineReasoningUi || hasToolsInTurnEarly
}

/** 将 activity 批次拆成：inline 思考 + Exploring 折叠内容（工具/工具间旁白） */
export function splitActivityForInlineReasoning(pieces: ActivityPiece[]): {
  reasoningPieces: Extract<ActivityPiece, { kind: 'reasoning' }>[]
  foldPieces: ActivityPiece[]
} {
  const reasoningPieces = reasoningPiecesInActivity(pieces) as Extract<
    ActivityPiece,
    { kind: 'reasoning' }
  >[]
  const foldPieces = pieces.filter((p) => p.kind !== 'reasoning')
  return { reasoningPieces, foldPieces }
}

export type ActivityRenderGroup =
  | { kind: 'reasoning'; piece: Extract<ActivityPiece, { kind: 'reasoning' }>; ordInBatch: number }
  | { kind: 'fold'; pieces: ActivityPiece[] }

/** 按时间线顺序分组：思考 ↔ Exploring 折叠（工具/旁白），工具后的思考排在 fold 之后 */
export function groupActivityPiecesChronologically(pieces: ActivityPiece[]): ActivityRenderGroup[] {
  const groups: ActivityRenderGroup[] = []
  let foldBuf: ActivityPiece[] = []
  let reasoningOrd = 0
  const flushFold = () => {
    if (!foldBuf.length) return
    groups.push({ kind: 'fold', pieces: foldBuf })
    foldBuf = []
  }
  for (const piece of pieces) {
    if (piece.kind === 'reasoning') {
      flushFold()
      groups.push({ kind: 'reasoning', piece, ordInBatch: reasoningOrd++ })
    } else {
      foldBuf.push(piece)
    }
  }
  flushFold()
  return groups
}

export function reasoningPieceFollowsToolsInBatch(
  pieces: ActivityPiece[],
  piece: Extract<ActivityPiece, { kind: 'reasoning' }>,
): boolean {
  const idx = pieces.findIndex((p) => p.kind === 'reasoning' && p.segIndex === piece.segIndex)
  if (idx < 0) return false
  for (let i = 0; i < idx; i++) {
    if (pieces[i].kind === 'tools') return true
  }
  return false
}

export function countReasoningPiecesInBatch(pieces: ActivityPiece[]): number {
  return reasoningPiecesInActivity(pieces).length
}

/** 同一 activity 批次内第 ord 段思考的展示标签（统一「思考」，不带序号） */
export function reasoningLabelForActivityPiece(
  _reasoningCountInBatch: number,
  _ordInBatch: number,
  _inExploring: boolean,
): string {
  return '思考'
}
