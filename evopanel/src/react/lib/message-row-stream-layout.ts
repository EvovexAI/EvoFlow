import {
  assistantBodiesLooselySame,
  // @ts-ignore
  flattenStreamDisplayText,
  joinStreamTextSegments,
  streamLiveTailForDisplay,
  turnHasVisibleChatTools,
} from '../../lib/chat-normalize.js'
import {
  coalesceAdjacentActivityChunks,
  dedupeLooseDuplicateTextChunks,
  dedupeStandaloneToolChunks,
  groupSegmentsForExploringDisplay,
  hasRichAnswerMarkup,
  isFinalReplyTextSegment,
  mergeOrphanToolsOnlyActivityChunks,
  collapseTurnToSingleExploringChunk,
  type SegmentDisplayChunk,
} from './exploring-activity-group.js'
import {
  displayChunksHaveReasoningPieces,
  // @ts-ignore
  flattenDisplayedChunkPlain,
  isReasoningOnlyActivityChunk,
  shouldRenderFinalReplyAtBottomOnly,
  // @ts-ignore
  streamLiveTailContainedInDisplay,
} from './message-row-stream-display.js'
import { collectOrphanToolsWithoutCallId } from './message-row-timeline.js'
import { resolveStreamLiveTailSlotForPlan } from './message-row-display-plan.js'
import { bubbleMarkdownText, visibleAssistantText, visibleExploringInnerText } from './message-row-visible-text.js'
import type { DisplayRow, MessageSegment } from '../chat-types.js'

export type StreamTextPhase = 'pre_tools' | 'post_tools'

export type StreamTimelineLayout = {
  displayChunks: SegmentDisplayChunk[]
  lastReasoningSegIdx: number
  /** layout 时间线末尾 segment 类型；用于判断思考流是否仍在进行 */
  lastTimelineSegmentKind: MessageSegment['kind'] | undefined
  streamTextPhase: StreamTextPhase
  firstActivityChunkIndex: number
  finalReplyChunkIndex: number
  streamLiveTailAnchorIndex: number
  showStreamPlanAtTop: boolean
  showStreamActivityWait: boolean
  renderFinalReplyAtBottom: boolean
  liveTailPreviewText: string
  orphanToolsNoId: unknown[]
  hasReasoningStreamUi: boolean
  showStreamThinkingCursor: boolean
  suppressLiveTailDuringPreToolReasoning: boolean
}

export type StreamLiveTailSlot =
  | { kind: 'bottom'; text: string; isStreaming: boolean }
  | { kind: 'fallback'; text: string; isStreaming: boolean }

/** Prefer the segment list that already materializes more assistant text (for live-tail strip). */
export function pickRicherStreamTextSegments(
  primary: MessageSegment[] | undefined,
  fallback: MessageSegment[],
): MessageSegment[] {
  const a = Array.isArray(primary) ? primary : []
  const b = Array.isArray(fallback) ? fallback : []
  if (!a.length) return b
  if (!b.length) return a
  const aPlain = joinStreamTextSegments(a, '')
  const bPlain = joinStreamTextSegments(b, '')
  return bPlain.length > aPlain.length ? b : a
}

function findLastReasoningSegmentIndex(segments: MessageSegment[]): number {
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].kind === 'reasoning') return i
  }
  return -1
}

/**
 * 首轮无工具：正文 segment 可能先于 reasoning 落盘（AG-UI append / wire 竞态），
 * 将 firstText 之后的 reasoning 整体上提到正文前，不依赖 reasoningPreview 是否非空。
 */
export function ensureReasoningBeforeFirstTextWhenNoTools(
  segs: MessageSegment[],
): MessageSegment[] {
  if (!segs.length || segs.some((s) => s.kind === 'tools')) return segs
  const firstText = segs.findIndex(
    (s) => s.kind === 'text' && String(s.text || '').trim(),
  )
  if (firstText < 0) return segs
  const misplaced = segs.filter(
    (s, j) => j > firstText && s.kind === 'reasoning' && String(s.text || '').trim(),
  )
  if (!misplaced.length) return segs
  const kept = segs.filter(
    (s, j) => !(j > firstText && s.kind === 'reasoning' && String(s.text || '').trim()),
  )
  return [...kept.slice(0, firstText), ...misplaced, ...kept.slice(firstText)]
}

/**
 * 未闭合思考若落在「正文 + 后续工具」之后，上提到该正文之前。
 * 首轮无工具时：正文 segment 可能因 wire/overlay 先于 preview 到达，思考仍应在上。
 */
function repositionOpenReasoningBeforeTrailingText(
  segs: MessageSegment[],
  openIdx: number,
): MessageSegment[] {
  if (openIdx < 0 || openIdx >= segs.length) return segs
  const hasTools = segs.some((s) => s.kind === 'tools')
  if (hasTools) return segs
  const firstText = segs.findIndex(
    (s) => s.kind === 'text' && String(s.text || '').trim(),
  )
  if (firstText < 0 || openIdx < firstText) return segs
  const open = segs[openIdx]
  const rest = [...segs.slice(0, openIdx), ...segs.slice(openIdx + 1)]
  const firstTextAfter = rest.findIndex(
    (s) => s.kind === 'text' && String(s.text || '').trim(),
  )
  if (firstTextAfter < 0) return segs
  return [...rest.slice(0, firstTextAfter), open, ...rest.slice(firstTextAfter)]
}

function insertOpenReasoningSegment(
  segs: MessageSegment[],
  preview: string,
): MessageSegment[] {
  const open: MessageSegment = { kind: 'reasoning', text: preview, id: '__open_reasoning__' }
  const hasTools = segs.some((s) => s.kind === 'tools')
  if (!hasTools) {
    const firstText = segs.findIndex(
      (s) => s.kind === 'text' && String(s.text || '').trim(),
    )
    if (firstText >= 0) {
      return [...segs.slice(0, firstText), open, ...segs.slice(firstText)]
    }
  }
  return [...segs, open]
}

/**
 * AG-UI 未 closed 的推理：写入时间线并保证到达顺序（越后越新）。
 * 禁止把新思考写回早期 reasoning，否则会在已输出的工具/正文上方「复燃」。
 */
export function layoutSegmentsWithOpenReasoning(opts: {
  displaySegments: MessageSegment[]
  reasoningPreview: string
  isStreaming: boolean
}): MessageSegment[] {
  if (!opts.isStreaming) return opts.displaySegments

  let segs = ensureReasoningBeforeFirstTextWhenNoTools([...opts.displaySegments])
  const preview = String(opts.reasoningPreview || '').trim()
  if (!preview) return segs
  const existingOpenIdx = segs.findIndex(
    (s) => s.kind === 'reasoning' && s.id === '__open_reasoning__',
  )
  if (existingOpenIdx >= 0) {
    segs[existingOpenIdx] = { ...segs[existingOpenIdx], text: preview }
    return repositionOpenReasoningBeforeTrailingText(segs, existingOpenIdx)
  }

  // 仅允许更新「仍处于时间线末尾」的开放思考；后面已有 tools/text 时不能回写更早槽位，
  // 但若 preview 仍属同一段思考（工具前首轮），允许就地延长，禁止尾插重复 reasoning。
  for (let i = segs.length - 1; i >= 0; i--) {
    if (segs[i].kind !== 'reasoning') continue
    const closed = String(segs[i].text || '').trim()
    if (!closed) continue
    const hasNewerAfter = segs.slice(i + 1).some(
      (s) =>
        s.kind === 'tools' ||
        (s.kind === 'text' && String(s.text || '').trim()) ||
        (s.kind === 'reasoning' && String(s.text || '').trim()),
    )
    const sameStream =
      segs[i].id === '__open_reasoning__' ||
      (closed.length >= 16 && (preview.startsWith(closed) || closed.startsWith(preview))) ||
      assistantBodiesLooselySame(closed, preview)
    if (hasNewerAfter) {
      if (sameStream && preview.length >= closed.length) {
        segs[i] = {
          ...segs[i],
          text: preview,
          id: segs[i].id || '__open_reasoning__',
        }
      }
      if (sameStream) return segs
      continue
    }
    if (!sameStream) continue
    if (preview.length >= closed.length) {
      segs[i] = {
        ...segs[i],
        text: preview,
        id: segs[i].id || '__open_reasoning__',
      }
    }
    return repositionOpenReasoningBeforeTrailingText(segs, i)
  }

  // 时间线已有工具、却没有任何 reasoning 段：说明首段 Thinking 已在 sealed/Exploring，
  // 此时仅凭 stale preview 尾插会把 Thinking 复燃到最新工具下方。
  // 真正的工具后新思考应由 AG-UI/stream 先写入 reasoning 段（timelineWithOpenAgUiReasoning）。
  if (segs.some((s) => s.kind === 'tools') && !segs.some((s) => s.kind === 'reasoning')) {
    return segs
  }

  return insertOpenReasoningSegment(segs, preview)
}

function resolveFinalReplyChunkIndex(opts: {
  displayChunks: SegmentDisplayChunk[]
  displaySegments: MessageSegment[]
  firstActivityChunkIndex: number
  tools: unknown[]
  interactiveToolApproval: boolean
  isStreaming: boolean
  suppressPlanExecPromptNoise: boolean
}): number {
  const {
    displayChunks,
    displaySegments,
    firstActivityChunkIndex,
    tools,
    interactiveToolApproval,
    isStreaming,
    suppressPlanExecPromptNoise,
  } = opts
  for (let i = displayChunks.length - 1; i >= 0; i--) {
    const c = displayChunks[i]
    if (c.kind !== 'text') continue
    if (
      !String(visibleAssistantText(c.text, tools, suppressPlanExecPromptNoise, isStreaming) || '').trim()
    ) {
      continue
    }
    if (firstActivityChunkIndex >= 0 && i < firstActivityChunkIndex) continue
    if (
      isFinalReplyTextSegment(
        displaySegments,
        c.segIndex,
        tools,
        interactiveToolApproval,
        isStreaming,
      )
    ) {
      return i
    }
  }
  return -1
}

/** 由 segments + tools 计算流式/历史时间线布局（纯数据，不含 JSX） */
export function buildStreamTimelineLayout(opts: {
  row: DisplayRow
  displaySegments: MessageSegment[]
  tools: unknown[]
  rawText: string
  textTrimmed: boolean
  reasoningSegments: string[]
  reasoningPreview: string
  isStreaming: boolean
  interactiveToolApproval: boolean
  suppressPlanExecPromptNoise: boolean
  hasToolsInTurnEarly: boolean
  useTimelineReasoningUi: boolean
}): StreamTimelineLayout {
  const {
    row,
    displaySegments,
    tools,
    rawText,
    textTrimmed,
    reasoningSegments,
    reasoningPreview,
    isStreaming,
    interactiveToolApproval,
    suppressPlanExecPromptNoise,
    hasToolsInTurnEarly,
    // @ts-ignore
    useTimelineReasoningUi,
  } = opts

  const layoutSegments = layoutSegmentsWithOpenReasoning({
    displaySegments,
    reasoningPreview,
    isStreaming,
  })
  const lastReasoningSegIdx = findLastReasoningSegmentIndex(layoutSegments)
  const lastTimelineSegmentKind = layoutSegments[layoutSegments.length - 1]?.kind
  const displayChunks = dedupeLooseDuplicateTextChunks(
    collapseTurnToSingleExploringChunk(
      dedupeStandaloneToolChunks(
        mergeOrphanToolsOnlyActivityChunks(
          coalesceAdjacentActivityChunks(
            groupSegmentsForExploringDisplay(
              layoutSegments,
              tools,
              interactiveToolApproval,
              isStreaming,
            ),
            isStreaming,
          ),
          tools,
        ),
      ),
    ),
  )
  const hasReasoningStreamUi =
    lastReasoningSegIdx >= 0 ||
    reasoningSegments.length > 0 ||
    !!String(reasoningPreview || '').trim() ||
    displayChunksHaveReasoningPieces(displayChunks)
  const showStreamThinkingCursor =
    isStreaming && !textTrimmed && !hasReasoningStreamUi && !String(row.systemActivity || '').trim()
  const hasToolsInTurn = turnHasVisibleChatTools(tools, displaySegments)
  const streamTextPhase: StreamTextPhase = hasToolsInTurn
    ? 'post_tools'
    : row.streamTextPhase === 'post_tools'
      ? 'post_tools'
      : 'pre_tools'
  const firstActivityChunkIndex = displayChunks.findIndex((c) => c.kind === 'activity')
  const firstActivityChunk =
    firstActivityChunkIndex >= 0 ? displayChunks[firstActivityChunkIndex] : undefined
  // @ts-ignore
  const firstActivityIsReasoningOnly = isReasoningOnlyActivityChunk(firstActivityChunk)
  const finalReplyChunkIndex = resolveFinalReplyChunkIndex({
    displayChunks,
    displaySegments,
    firstActivityChunkIndex,
    tools,
    interactiveToolApproval,
    isStreaming,
    suppressPlanExecPromptNoise,
  })
  const mergedLiveTailPreview = streamLiveTailForDisplay(
    // Prefer displaySegments when richer: streamTailDedupe can lag behind open text that
    // is already absorbed into Exploring, which would wrongly leave a live-tail duplicate.
    pickRicherStreamTextSegments(
      row.streamTailDedupeSegments as MessageSegment[] | undefined,
      displaySegments,
    ),
    rawText,
  )
  const preferExploringInnerTail =
    !hasRichAnswerMarkup(mergedLiveTailPreview) &&
    ((hasToolsInTurn && streamTextPhase === 'post_tools') || hasToolsInTurnEarly)
  const liveTailPreviewText = bubbleMarkdownText(
    preferExploringInnerTail
      ? visibleExploringInnerText(mergedLiveTailPreview, suppressPlanExecPromptNoise, true, tools)
      : visibleAssistantText(
          mergedLiveTailPreview,
          tools,
          suppressPlanExecPromptNoise,
          isStreaming,
        ),
  )
  const hasLiveTailContent = !!String(liveTailPreviewText || '').trim()
  const showStreamActivityWait =
    isStreaming &&
    !hasLiveTailContent &&
    (showStreamThinkingCursor || !!String(row.systemActivity || '').trim())
  const renderFinalReplyAtBottom = shouldRenderFinalReplyAtBottomOnly(
    finalReplyChunkIndex,
    firstActivityChunkIndex,
  )
  let streamLiveTailAnchorIndex = -1
  for (let i = displayChunks.length - 1; i >= 0; i--) {
    if (displayChunks[i].kind === 'activity') {
      streamLiveTailAnchorIndex = i
      break
    }
  }
  const orphanToolsNoId = isStreaming ? collectOrphanToolsWithoutCallId(tools) : []

  return {
    displayChunks,
    lastReasoningSegIdx,
    lastTimelineSegmentKind,
    streamTextPhase,
    firstActivityChunkIndex,
    finalReplyChunkIndex,
    streamLiveTailAnchorIndex,
    showStreamPlanAtTop: false,
    showStreamActivityWait,
    renderFinalReplyAtBottom,
    liveTailPreviewText,
    orphanToolsNoId,
    hasReasoningStreamUi,
    showStreamThinkingCursor,
    suppressLiveTailDuringPreToolReasoning: false,
  }
}

/** @deprecated 展示顺序见 message-row-display-plan；保留供单测与旧引用 */
export function resolveStreamLiveTailSlot(opts: {
  layout: StreamTimelineLayout
  displaySegments: MessageSegment[]
  displayChunks: SegmentDisplayChunk[]
  isStreaming: boolean
  suppressPlanExecPromptNoise: boolean
  reasoningPreview?: string
  lastReasoningSegIdx?: number
}): StreamLiveTailSlot | null {
  return resolveStreamLiveTailSlotForPlan(opts)
}

function lastToolsSegmentIndex(segments: MessageSegment[]): number {
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].kind === 'tools') return i
  }
  return -1
}

function reasoningRenderedAfterToolsInChunks(
  displayChunks: SegmentDisplayChunk[],
  lastReasoningSegIdx: number,
): boolean {
  for (const chunk of displayChunks) {
    if (chunk.kind !== 'activity') continue
    let sawTools = false
    for (const piece of chunk.pieces) {
      if (piece.kind === 'tools') sawTools = true
      if (
        piece.kind === 'reasoning' &&
        sawTools &&
        piece.segIndex === lastReasoningSegIdx &&
        String(piece.text || '').trim()
      ) {
        return true
      }
    }
  }
  return false
}

/** 工具执行后的流式思考：固定在气泡最底部（时间线尚未写入 activity 时的兜底） */
export function resolveStreamReasoningTailSlot(opts: {
  isStreaming: boolean
  displaySegments: MessageSegment[]
  displayChunks: SegmentDisplayChunk[]
  reasoningPreview: string
  lastReasoningSegIdx: number
}): { text: string } | null {
  const { isStreaming, displaySegments, displayChunks, reasoningPreview, lastReasoningSegIdx } = opts
  if (!isStreaming || lastReasoningSegIdx < 0) return null
  const preview = String(reasoningPreview || '').trim()
  if (!preview) return null
  const toolsIdx = lastToolsSegmentIndex(displaySegments)
  if (toolsIdx < 0 || lastReasoningSegIdx <= toolsIdx) return null
  if (reasoningRenderedAfterToolsInChunks(displayChunks, lastReasoningSegIdx)) return null
  return { text: preview }
}