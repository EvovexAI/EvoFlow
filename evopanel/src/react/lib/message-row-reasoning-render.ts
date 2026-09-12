import { assistantBodiesLooselySame } from '../../lib/chat-normalize.js'
import type { MessageSegment } from '../chat-types.js'
import type { ActivityPiece, SegmentDisplayChunk } from './exploring-activity-group.js'
import { toolsForActivityPieces } from './exploring-activity-group.js'
import { visibleAssistantText } from './message-row-visible-text.js'

export function reasoningPieceTextInChunks(
  displayChunks: SegmentDisplayChunk[],
  segIndex: number,
): string {
  if (segIndex < 0) return ''
  for (const chunk of displayChunks) {
    if (chunk.kind !== 'activity') continue
    for (const piece of chunk.pieces) {
      if (piece.kind === 'reasoning' && piece.segIndex === segIndex) {
        return String(piece.text || '').trim()
      }
    }
  }
  return ''
}

/** 该 reasoning 段是否已在 displayChunks（含 activity 内）渲染 */
export function reasoningSegmentRenderedInChunks(
  displayChunks: SegmentDisplayChunk[],
  segIndex: number,
): boolean {
  return reasoningPieceTextInChunks(displayChunks, segIndex).length > 0
}

/** preview 是否已完整出现在 activity 折叠内（允许折叠内略短于 preview） */
export function isReasoningFullyRenderedInChunks(
  preview: string,
  displayChunks: SegmentDisplayChunk[],
  segIndex: number,
): boolean {
  const pieceText = reasoningPieceTextInChunks(displayChunks, segIndex)
  const p = String(preview || '').trim()
  if (!p) return !!pieceText
  if (!pieceText) return false
  if (p.length > pieceText.length + 8) return false
  return pieceText === p || assistantBodiesLooselySame(pieceText, p)
}

export function lastToolsSegmentIndexInTimeline(segments: MessageSegment[]): number {
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].kind === 'tools') return i
  }
  return -1
}

/** 流式活跃思考：优先 preview（SSE 累积全文），其次 timeline 封存片段 */
/**
 * 该 reasoning 段是否正在接收流式 delta。
 * 仅当该段是时间线「最后一段推理」且时间线末尾仍是 reasoning 时，才把 live preview 灌入。
 * 若末尾已是 tools/text，说明更新的思考应落在更后的新槽位——禁止回灌更早思考（否则会跳到工具上方）。
 */
export function isReasoningPieceActivelyStreaming(opts: {
  isStreaming: boolean
  pieceSegIndex: number
  lastReasoningSegIdx: number
  lastTimelineSegmentKind?: string
  pieceId?: string
}): boolean {
  if (!opts.isStreaming) return false
  if (opts.pieceSegIndex !== opts.lastReasoningSegIdx) return false
  if (opts.lastTimelineSegmentKind && opts.lastTimelineSegmentKind !== 'reasoning') {
    return false
  }
  return true
}

export function resolveActiveReasoningDisplayText(
  pieceText: string,
  reasoningPreview: string,
  isActive: boolean,
): string {
  const piece = String(pieceText || '').trim()
  const preview = String(reasoningPreview || '').trim()
  if (!isActive) return piece
  if (preview && (!piece || preview.length >= piece.length)) {
    if (
      !piece ||
      preview.startsWith(piece) ||
      piece.startsWith(preview) ||
      assistantBodiesLooselySame(piece, preview)
    ) {
      return preview
    }
    return piece
  }
  return piece || preview
}

export function shouldHidePostToolReasoningAsBodyDup(opts: {
  isStreaming: boolean
  streamTextPhase: 'pre_tools' | 'post_tools'
  piece: Extract<ActivityPiece, { kind: 'reasoning' }>
  activityPieces: ActivityPiece[]
  displaySegments: MessageSegment[]
  rawText: string
}): boolean {
  const { isStreaming, streamTextPhase, piece, activityPieces, displaySegments, rawText } = opts
  if (!isStreaming || streamTextPhase !== 'post_tools') return false
  const toolsIdx = lastToolsSegmentIndexInTimeline(displaySegments)
  if (toolsIdx >= 0 && piece.segIndex > toolsIdx) return false
  let sawTools = false
  for (const p of activityPieces) {
    if (p.kind === 'tools') sawTools = true
    if (p.kind === 'reasoning' && p.segIndex === piece.segIndex && sawTools) return false
  }
  const rt = String(piece.text || '').trim()
  const ot = String(rawText || '').trim()
  return ot.length > 60 && rt.includes(ot.slice(0, Math.min(64, ot.length)))
}

/** Exploring fold 内是否会有可见 DOM（与 ExploringActivityChunk 过滤规则对齐） */
export function activityFoldHasVisibleInnerContent(opts: {
  activityPieces: ActivityPiece[]
  tools: unknown[]
  isStreaming: boolean
  lastReasoningSegIdx: number
  streamTextPhase: 'pre_tools' | 'post_tools'
  displaySegments: MessageSegment[]
  rawText: string
  reasoningPreview?: string
  skipReasoningSegIndex?: number | null
  suppressPlanExecPromptNoise?: boolean
  lastTimelineSegmentKind?: string
}): boolean {
  const {
    activityPieces,
    tools,
    isStreaming,
    lastReasoningSegIdx,
    streamTextPhase,
    displaySegments,
    rawText,
    reasoningPreview = '',
    skipReasoningSegIndex = null,
    suppressPlanExecPromptNoise = false,
    lastTimelineSegmentKind,
  } = opts

  for (const piece of activityPieces) {
    if (piece.kind === 'reasoning') {
      if (skipReasoningSegIndex != null && piece.segIndex === skipReasoningSegIndex) continue
      if (
        shouldHidePostToolReasoningAsBodyDup({
          isStreaming,
          streamTextPhase,
          piece,
          activityPieces,
          displaySegments,
          rawText,
        })
      ) {
        continue
      }
      const isActiveReasoning = isReasoningPieceActivelyStreaming({
        isStreaming,
        pieceSegIndex: piece.segIndex,
        lastReasoningSegIdx,
        lastTimelineSegmentKind,
        pieceId: piece.id,
      })
      const displayText = resolveActiveReasoningDisplayText(
        piece.text,
        reasoningPreview,
        isActiveReasoning,
      )
      if (String(displayText || '').trim() || isActiveReasoning) return true
      continue
    }
    if (piece.kind === 'text') {
      const innerText = visibleAssistantText(
        piece.text,
        tools,
        suppressPlanExecPromptNoise,
        true,
      )
      if (String(innerText || '').trim()) return true
      continue
    }
    if (piece.kind === 'tools') {
      const visible = toolsForActivityPieces([piece], tools)
      if (visible.length) return true
    }
  }
  return false
}
