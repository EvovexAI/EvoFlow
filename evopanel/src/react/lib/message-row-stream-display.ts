import {
  assistantBodiesLooselySame,
  normalizeStreamPlainLoose,
} from '../../lib/chat-normalize.js'
import { hasRichAnswerMarkup, type SegmentDisplayChunk } from './exploring-activity-group.js'
import type { AssistantBubbleSlot } from './message-row-display-plan.js'
import {
  bubbleMarkdownText,
  planTopDisplayText,
  visibleAssistantText,
  visibleExploringInnerText,
} from './message-row-visible-text.js'

export type FinalBodyVisibilityOpts = {
  tools?: unknown[]
  suppressPlanExecPromptNoise?: boolean
  isStreaming?: boolean
}

function slotHasFilteredVisibleBody(
  slot: AssistantBubbleSlot,
  opts: FinalBodyVisibilityOpts,
): boolean {
  const tools = opts.tools ?? []
  const suppress = !!opts.suppressPlanExecPromptNoise
  const isStreaming = !!opts.isStreaming
  if (slot.kind === 'live-tail' || slot.kind === 'plain-body' || slot.kind === 'legacy-body') {
    return !!String(slot.text || '').trim()
  }
  if (slot.kind === 'chunk' && slot.chunk.kind === 'text') {
    const visible = visibleExploringInnerText(slot.chunk.text, suppress, isStreaming, tools)
    return !!String(bubbleMarkdownText(visible) || '').trim()
  }
  return false
}

/** 折叠区下方是否已有可见正文（过滤噪声后；有则允许 Explored 收起） */
export function hasVisibleBodyBelowActivityChunk(
  slots: AssistantBubbleSlot[],
  activityChunkIndex: number,
  opts: FinalBodyVisibilityOpts = {},
): boolean {
  let passed = false
  for (const slot of slots) {
    if (slot.kind === 'chunk' && slot.chunkIndex === activityChunkIndex) {
      passed = true
      continue
    }
    if (!passed) continue
    if (slotHasFilteredVisibleBody(slot, opts)) return true
  }
  return false
}

function normalizedFinalBodyText(
  raw: string,
  opts: FinalBodyVisibilityOpts & { preferExploringInner?: boolean },
): string {
  const tools = opts.tools ?? []
  const suppress = !!opts.suppressPlanExecPromptNoise
  const isStreaming = !!opts.isStreaming
  const visible = opts.preferExploringInner
    ? visibleExploringInnerText(raw, suppress, isStreaming, tools)
    : visibleAssistantText(raw, tools, suppress, isStreaming)
  return String(bubbleMarkdownText(visible) || '').trim()
}

/**
 * 流式结束后 Final 正文交接兜底：live-tail 关闭且 chunk map 无可见正文时，
 * 从 final chunk / liveTailPreview / rawText 补一条底部正文 slot。
 */
export function resolveFinalReplyFallbackSlot(
  input: FinalBodyVisibilityOpts & {
    isStreaming: boolean
    firstActivityChunkIndex: number
    finalReplyChunkIndex: number
    renderFinalReplyAtBottom: boolean
    liveTailPreviewText: string
    displayChunks: SegmentDisplayChunk[]
    slots: AssistantBubbleSlot[]
    rawText: string
    text: string
  },
): AssistantBubbleSlot | null {
  if (input.isStreaming) return null
  // 无最终回复 chunk 时不兜底：避免 turn 以工具结束时把工具间旁白/rawText 拼到底部
  if (input.finalReplyChunkIndex < 0) return null

  const activityChunkIndex = input.firstActivityChunkIndex

  const visOpts: FinalBodyVisibilityOpts = {
    tools: input.tools,
    suppressPlanExecPromptNoise: input.suppressPlanExecPromptNoise,
    isStreaming: false,
  }

  if (activityChunkIndex >= 0) {
    if (hasVisibleBodyBelowActivityChunk(input.slots, activityChunkIndex, visOpts)) {
      return null
    }
  } else if (input.slots.some((slot) => slotHasFilteredVisibleBody(slot, visOpts))) {
    return null
  }

  const preferInner = input.renderFinalReplyAtBottom || activityChunkIndex >= 0
  const candidates: string[] = []
  if (input.finalReplyChunkIndex >= 0) {
    const chunk = input.displayChunks[input.finalReplyChunkIndex]
    if (chunk?.kind === 'text') candidates.push(String(chunk.text || ''))
  }
  if (String(input.liveTailPreviewText || '').trim()) {
    candidates.push(String(input.liveTailPreviewText))
  }
  if (String(input.rawText || '').trim()) candidates.push(String(input.rawText))
  if (String(input.text || '').trim()) candidates.push(String(input.text))

  const seen = new Set<string>()
  for (const raw of candidates) {
    const body = normalizedFinalBodyText(raw, { ...visOpts, preferExploringInner: preferInner })
    if (!body) continue
    const key = normalizeStreamPlainLoose(body)
    if (seen.has(key)) continue
    seen.add(key)
    return { kind: 'live-tail', text: body, isStreaming: false }
  }
  return null
}

/** activity chunk 内是否仅有 reasoning（无 tools/text） */
export function isReasoningOnlyActivityChunk(chunk: SegmentDisplayChunk | undefined): boolean {
  return (
    chunk?.kind === 'activity' &&
    chunk.pieces.length > 0 &&
    chunk.pieces.every((p) => p.kind === 'reasoning')
  )
}

export function displayChunksHaveExploringTools(chunks: SegmentDisplayChunk[]): boolean {
  return chunks.some(
    (c) => c.kind === 'activity' && c.pieces.some((p) => p.kind === 'tools'),
  )
}

/** 首个含 Exploring 工具的 activity 之前的计划 text chunk（scenario 后的开场白） */
export function findPlanTopTextChunk(opts: {
  displayChunks: SegmentDisplayChunk[]
  suppressPlanExecPromptNoise: boolean
}): { text: string; chunkIndex: number } | null {
  const { displayChunks, suppressPlanExecPromptNoise } = opts
  for (let i = 0; i < displayChunks.length; i++) {
    const chunk = displayChunks[i]
    if (chunk.kind === 'activity' && chunk.pieces.some((p) => p.kind === 'tools')) break
    if (chunk.kind !== 'text') continue
    const text = planTopDisplayText(chunk.text, suppressPlanExecPromptNoise)
    if (!text || hasRichAnswerMarkup(text)) continue
    return { text: bubbleMarkdownText(text), chunkIndex: i }
  }
  return null
}

/** @deprecated 首段正文不再从 live-tail 中 suppress */
export function shouldSuppressLiveTailDuringPreToolReasoning(_opts: {
  isStreaming: boolean
  streamTextPhase: 'pre_tools' | 'post_tools'
  hasToolsInTurn: boolean
  firstActivityChunkIndex: number
  hasReasoningStreamUi: boolean
}): boolean {
  return false
}

/** 工具前计划正文：不再特殊处理，首次正文与普通消息同等对待 */
export function shouldShowStreamPlanAtTop(_opts: {
  isStreaming: boolean
  streamTextPhase: 'pre_tools' | 'post_tools'
  hasToolsInTurn: boolean
  useTimelineReasoningUi: boolean
  firstActivityChunkIndex: number
  firstActivityIsReasoningOnly?: boolean
  textTrimmed: boolean
  planAlreadyInChunks: boolean
}): boolean {
  return false
}

/** 工具后的最终正文固定由底部 slot 渲染，避免流式结束从 tail 跳到 chunk 区 */
export function shouldRenderFinalReplyAtBottomOnly(
  finalReplyChunkIndex: number,
  firstActivityChunkIndex: number,
): boolean {
  return (
    finalReplyChunkIndex >= 0 &&
    firstActivityChunkIndex >= 0 &&
    finalReplyChunkIndex > firstActivityChunkIndex
  )
}

/** 流式 post_tools：仅隐藏当前最终正文 chunk（由底部 live tail 渲染）；已封存轮次正文仍留在 map */
export function shouldHideStreamingPostToolsTextChunk(
  isStreaming: boolean,
  streamTextPhase: 'pre_tools' | 'post_tools',
  chunkKind: string,
  chunkIndex: number,
  firstActivityChunkIndex: number,
  finalReplyChunkIndex = -1,
): boolean {
  return (
    !!isStreaming &&
    streamTextPhase === 'post_tools' &&
    chunkKind === 'text' &&
    firstActivityChunkIndex >= 0 &&
    chunkIndex > firstActivityChunkIndex &&
    finalReplyChunkIndex >= 0 &&
    chunkIndex === finalReplyChunkIndex
  )
}

/** displayChunks.map 中是否跳过该 text chunk（流式期间由底部 slot 独占；结束后回到 map 正常渲染） */
export function shouldHideFinalReplyTextChunkInMap(
  chunkIndex: number,
  chunkKind: string,
  isStreaming: boolean,
  streamTextPhase: 'pre_tools' | 'post_tools',
  firstActivityChunkIndex: number,
  finalReplyChunkIndex: number,
): boolean {
  if (chunkKind !== 'text') return false
  if (
    isStreaming &&
    shouldRenderFinalReplyAtBottomOnly(finalReplyChunkIndex, firstActivityChunkIndex) &&
    chunkIndex === finalReplyChunkIndex
  ) {
    return true
  }
  return shouldHideStreamingPostToolsTextChunk(
    isStreaming,
    streamTextPhase,
    chunkKind,
    chunkIndex,
    firstActivityChunkIndex,
    finalReplyChunkIndex,
  )
}

/** 底部 live tail 是否已被 segments / displayChunks 覆盖（流式期间也生效） */
export function streamLiveTailContainedInDisplay(
  liveTrimmed: string,
  segPlain: string,
  chunkPlain: string,
): boolean {
  const live = String(liveTrimmed || '')
  if (!live) return true
  const seg = normalizeStreamPlainLoose(segPlain)
  const chunks = normalizeStreamPlainLoose(chunkPlain)
  const liveN = normalizeStreamPlainLoose(live)
  if (seg && (seg === liveN || assistantBodiesLooselySame(segPlain, live))) return true
  if (chunks && (chunks === liveN || assistantBodiesLooselySame(chunkPlain, live))) return true
  if (seg && chunks) {
    const merged = normalizeStreamPlainLoose(`${segPlain}\n${chunkPlain}`)
    if (merged === liveN || assistantBodiesLooselySame(`${segPlain}\n${chunkPlain}`, live)) return true
  }
  return false
}

export function displayChunksHaveReasoningPieces(chunks: SegmentDisplayChunk[]): boolean {
  return chunks.some(
    (c) => c.kind === 'activity' && c.pieces.some((p) => p.kind === 'reasoning'),
  )
}

export function flattenDisplayedChunkPlain(
  chunks: SegmentDisplayChunk[],
  _firstActivityChunkIndex: number,
  toVisibleText: (chunk: Extract<SegmentDisplayChunk, { kind: 'text' }>, index: number) => string,
): string {
  const parts: string[] = []
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci]
    if (chunk.kind !== 'text') continue
    const segText = toVisibleText(chunk, ci)
    if (String(segText || '').trim()) parts.push(segText)
  }
  return parts.join('\n')
}
