/**
 * 助手气泡展示总控（唯一竖直顺序权威）
 *
 * 约定（从上到下，越靠后越新；主内容区最底为 live-tail / plain-body / legacy-body）：
 *   计划顶栏 → 时间线 chunks / legacy 工具 → 最新思考 → 最新正文 → orphan 工具 → 占位
 *   非流式完成轮的「运行过程」视觉位置由 CSS order 放在正文前（不改 slot 时序）
 *
 * 数据写入：stream-turn-engine（openText + reasoningPreview + segments）
 * 本模块只负责：路径选择 + slot 顺序 + 用哪段文本渲染
 */
import type { DisplayRow, MessageSegment } from '../chat-types.js'
import type { SegmentDisplayChunk } from './exploring-activity-group.js'
import type { AgUiTurnState } from './agui-turn-reducer.js'
import { normalizeStreamStatusLabel } from './stream-status-label.js'
import {
  assistantBodiesLooselySame,
  flattenStreamDisplayText,
  isToolRunning,
  normalizeAssistantSegmentTimelineOrder,
  turnHasVisibleChatTools,
} from '../../lib/chat-normalize.js'
import {
  buildStreamTimelineLayout,
  type StreamTimelineLayout,
} from './message-row-stream-layout.js'
import {
  flattenDisplayedChunkPlain,

  // @ts-ignore
  hasVisibleBodyBelowActivityChunk,
  resolveFinalReplyFallbackSlot,
  shouldHideFinalReplyTextChunkInMap,
  shouldRenderFinalReplyAtBottomOnly,
  streamLiveTailContainedInDisplay,
} from './message-row-stream-display.js'
import { collectOrphanToolsWithoutCallId } from './message-row-timeline.js'
// @ts-ignore
import {
  isReasoningFullyRenderedInChunks,
  lastToolsSegmentIndexInTimeline,
  resolveActiveReasoningDisplayText,
} from './message-row-reasoning-render.js'
import { bubbleMarkdownText, visibleAssistantText, visibleExploringInnerText, visiblePreToolTimelineText } from './message-row-visible-text.js'

export type AssistantBubblePath = 'agui' | 'timeline' | 'plain' | 'legacy'

export type AssistantBubbleSlot =
  | {
      kind: 'top-reasoning'
      text: string
      label: string
      isStreamingActive: boolean
      ord: number
    }
  | { kind: 'plan-top'; text: string }
  | { kind: 'chunk'; chunk: SegmentDisplayChunk; chunkIndex: number }
  | { kind: 'reasoning-pending'; text: string; segIndex: number }
  | { kind: 'live-tail'; text: string; isStreaming: boolean }
  | { kind: 'plain-body'; text: string; isStreaming: boolean }
  | { kind: 'legacy-tools' }
  | { kind: 'legacy-body'; text: string; isStreaming: boolean }
  | { kind: 'orphan-tools'; tools: unknown[] }
  | { kind: 'tool-row'; toolCallIds: string[] }
  | { kind: 'thinking-wait'; label: string }

export type AssistantBubbleDisplayPlan = {
  path: AssistantBubblePath
  layout: StreamTimelineLayout | null
  slots: AssistantBubbleSlot[]
  /** 由 reasoning-pending 负责展示时，fold 内同 segIndex 须跳过，避免双份 */
  pendingReasoningSegIndex: number | null
}

export type AssistantBubblePlanInput = {
  row: DisplayRow
  displaySegments: MessageSegment[]
  tools: unknown[]
  rawText: string
  text: string
  textTrimmed: boolean
  reasoningPreview: string
  reasoningSegments: string[]
  isStreaming: boolean
  interactiveToolApproval: boolean
  suppressPlanExecPromptNoise: boolean
  hasToolsInTurnEarly: boolean
  systemActivityLabel: string
  streamThinkingLabel: string
  /** legacy：气泡内是否显示工具列表 */
  legacyHasTools: boolean
  /** legacy / plain：是否显示正文区 */
  legacyShowBody: boolean
  /** plain：合并 segments + openText 的全文 */
  plainBodyRaw: string
  plainShowThinkingCursor: boolean
  /** AG-UI canonical turn — when set, display uses agui projection only */
  aguiTurn?: AgUiTurnState | null
}

// @ts-ignore
function findLastReasoningSegmentIndex(segments: MessageSegment[]): number {
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].kind === 'reasoning') return i
  }
  return -1
}

/**
 * 流式状态行文案（"思考中/正在调用工具/生成中"）。
 * 优先级：模型显式 activity > 工具运行中 > 思考流中 > 正文生成中 > 兜底"思考中…"。
 * 入参为 plan 的 input，无需 AG-UI state；保持与 timeline/plain/legacy/agui 路径解耦。
 */
function resolveStreamStatusLabel(input: AssistantBubblePlanInput): string {
  // 后端统一推送：前端只消费 systemActivityLabel，不做任何内容推断。
  // 后端在 reasoning delta → "思考中…"，text delta → "输出中…"，
  // tool_call → "调用：xxx"，tool finished → "推理中" 等时机主动推送。
  const explicit = normalizeStreamStatusLabel(input.systemActivityLabel || '')
  if (explicit) return explicit
  return ''
}

function appendStreamingStatusSlot(
  slots: AssistantBubbleSlot[],
  input: AssistantBubblePlanInput,
): void {
  if (!input.isStreaming) return
  // 流式始终保留一行状态（缺省「生成中」），耗时/tools/tip 统一挂在这里
  const label = resolveStreamStatusLabel(input) || '生成中'
  const last = slots[slots.length - 1]
  if (last && last.kind === 'thinking-wait') {
    last.label = label
    return
  }
  slots.push({ kind: 'thinking-wait', label })
}

/** 无工具纯流式：无 tools/reasoning/sealed-text segment 的时间线 */
export function shouldUsePlainStreamPath(opts: {
  isStreaming: boolean
  hasToolsInTurnEarly: boolean
  displaySegments: MessageSegment[]
  reasoningPreview?: string
}): boolean {
  if (!opts.isStreaming || opts.hasToolsInTurnEarly) return false
  if (String(opts.reasoningPreview || '').trim()) return false
  if (opts.displaySegments.some((s) => s.kind === 'tools' || s.kind === 'reasoning')) return false
  // Block 已封存（body_text closed）→ 有 sealed text segment，走 agui 路径
  // 让已封存正文走 MarkdownHtml isStreaming=false 渲染，而非 plain 路径的 <pre> 原始文本
  if (opts.displaySegments.some((s) => s.kind === 'text')) return false
  return true
}

function turnHasTimelineContent(input: AssistantBubblePlanInput): boolean {
  if (input.displaySegments.length) return true
  if (input.legacyHasTools || input.hasToolsInTurnEarly) return true
  if (turnHasVisibleChatTools(input.tools, input.displaySegments)) return true
  if (input.textTrimmed) return true
  if (String(input.reasoningPreview || '').trim()) return true
  if (input.reasoningSegments.length) return true
  return false
}

function displaySegmentsHaveAuthoritativeSeq(segments: MessageSegment[]): boolean {
  if (!Array.isArray(segments) || segments.length < 2) return false
  const withSeq = segments.filter(
    (s) => s && typeof s.seq === 'number' && Number.isFinite(s.seq),
  )
  if (withSeq.length === segments.length) return true
  if (withSeq.length >= segments.length - 1 && segments.some((s) => s?.kind === 'tools')) {
    return true
  }
  return false
}

function resolveBubblePath(input: AssistantBubblePlanInput): AssistantBubblePath {
  if (input.isStreaming && input.row.role === '_stream') {
    if (
      shouldUsePlainStreamPath({
        isStreaming: input.isStreaming,
        hasToolsInTurnEarly: input.hasToolsInTurnEarly,
        displaySegments: input.displaySegments,
        reasoningPreview: input.reasoningPreview,
      })
    ) {
      return 'plain'
    }
    // 正文+工具：严格 seq 竖排（1→2→3），禁止 Exploring 重排导致「工具全在上、正文全在下」
    if (
      input.aguiTurn ||
      input.hasToolsInTurnEarly ||
      turnHasVisibleChatTools(input.tools, input.displaySegments)
    ) {
      return 'agui'
    }
    if (turnHasTimelineContent(input)) return 'timeline'
    return 'legacy'
  }
  // 落库/历史：wire 权威 seq 时间线走 agui 顺序路径，封存块位置固定
  if (displaySegmentsHaveAuthoritativeSeq(input.displaySegments)) return 'agui'
  if (input.aguiTurn && !input.isStreaming) return 'agui'
  if (
    shouldUsePlainStreamPath({
      isStreaming: input.isStreaming,
      hasToolsInTurnEarly: input.hasToolsInTurnEarly,
      displaySegments: input.displaySegments,
      reasoningPreview: input.reasoningPreview,
    })
  ) {
    return 'plain'
  }
  if (turnHasTimelineContent(input)) return 'timeline'
  return 'legacy'
}

function findToolByCallId(tools: unknown[], id: string): unknown | undefined {
  const want = String(id || '').trim()
  if (!want) return undefined
  for (const raw of tools || []) {
    const o = raw as Record<string, unknown>
    const rid = o.id != null && String(o.id).trim() !== '' ? String(o.id).trim() : ''
    const rtc =
      o.tool_call_id != null && String(o.tool_call_id).trim() !== ''
        ? String(o.tool_call_id).trim()
        : ''
    if (rid === want || rtc === want) return raw
  }
  return undefined
}

// @ts-ignore
function hasRunningVisibleToolsAfterIndex(
  displaySegments: MessageSegment[],
  tools: unknown[],
  toolsIdx: number,
): boolean {
  for (let i = toolsIdx + 1; i < displaySegments.length; i++) {
    const seg = displaySegments[i]
    if (seg.kind !== 'tools') continue
    for (const raw of seg.ids || []) {
      const id = String(raw).trim()
      if (!id) continue
      const t = findToolByCallId(tools, id)
      if (t && isToolRunning(t)) {
        return true
      }
    }
  }
  return false
}

function resolvePostToolPendingReasoning(_opts: {
  isStreaming: boolean
  displaySegments: MessageSegment[]
  displayChunks: SegmentDisplayChunk[]
  reasoningPreview: string
  tools: unknown[]
  liveTailPreviewText: string
}): AssistantBubbleSlot | null {
  // 流式思考一律在时间线 / Exploring 内按到达顺序渲染，禁止 reasoning-pending 插队
  return null
}

/** 最新正文 live tail（仅 display-plan 调用；不再因「思考未进 fold」而 suppress 正文） */
function resolveLiveTailSlot(opts: {
  layout: StreamTimelineLayout
  displaySegments: MessageSegment[]
  displayChunks: SegmentDisplayChunk[]
  isStreaming: boolean
  suppressPlanExecPromptNoise: boolean
  tools: unknown[]
}): { text: string; isStreaming: boolean } | null {
  const { layout, displaySegments, displayChunks, isStreaming, suppressPlanExecPromptNoise, tools } =
    opts
  const {
    renderFinalReplyAtBottom,
    finalReplyChunkIndex,
    firstActivityChunkIndex,
    liveTailPreviewText,
  } = layout

  if (!isStreaming && renderFinalReplyAtBottom && finalReplyChunkIndex >= 0) return null

  const segPlain = flattenStreamDisplayText(displaySegments, '').trim()
  const chunkPlain = flattenDisplayedChunkPlain(
    displayChunks,
    firstActivityChunkIndex,
    (c, idx) => {
      if (renderFinalReplyAtBottom && idx === finalReplyChunkIndex) return ''
      return firstActivityChunkIndex >= 0 && idx < firstActivityChunkIndex
        ? visiblePreToolTimelineText(c.text, suppressPlanExecPromptNoise, true)
        : visibleExploringInnerText(c.text, suppressPlanExecPromptNoise, true, tools)
    },
  ).trim()
  const liveTrimmed = String(liveTailPreviewText || '').trim()
  if (!liveTrimmed) return null

  if (liveTailTextCoveredByExploring(displayChunks, liveTrimmed)) return null

  if (renderFinalReplyAtBottom && finalReplyChunkIndex >= 0) {
    const finalChunk = displayChunks[finalReplyChunkIndex]
    const bottomText = bubbleMarkdownText(
      isStreaming || !finalChunk || finalChunk.kind !== 'text'
        ? liveTailPreviewText
        : visibleExploringInnerText(finalChunk.text, suppressPlanExecPromptNoise, isStreaming, tools),
    )
    const bottomTrimmed = String(bottomText || '').trim()
    if (!bottomTrimmed) return null
    if (streamLiveTailContainedInDisplay(bottomTrimmed, segPlain, chunkPlain)) return null
    return { text: bottomText, isStreaming }
  }

  if (streamLiveTailContainedInDisplay(liveTrimmed, segPlain, chunkPlain)) return null
  if (!isStreaming && finalReplyChunkIndex >= 0) {
    const finalChunk = displayChunks[finalReplyChunkIndex]
    if (
      finalChunk?.kind === 'text' &&
      assistantBodiesLooselySame(liveTrimmed, String(finalChunk.text || ''))
    ) {
      return null
    }
  }
  return { text: bubbleMarkdownText(liveTailPreviewText), isStreaming }
}

function topReasoningSlots(
  reasoningSegments: string[],
  isStreaming: boolean,
): AssistantBubbleSlot[] {
  return reasoningSegments.map((text, ord) => ({
    kind: 'top-reasoning' as const,
    text,
    label: '思考',
    isStreamingActive: !!(isStreaming && ord === reasoningSegments.length - 1),
    ord,
  }))
}


function activityChunkToSlots(opts: {
  chunk: SegmentDisplayChunk
  chunkIndex: number
  firstActivityChunkIndex: number
  isStreaming: boolean
}): AssistantBubbleSlot[] {
  const { chunk, chunkIndex } = opts
  return [{ kind: 'chunk', chunk, chunkIndex }]
}

function buildTimelinePlan(input: AssistantBubblePlanInput): AssistantBubbleDisplayPlan {
  const useTimelineReasoningUi =
    turnHasVisibleChatTools(input.tools, input.displaySegments) &&
    (input.displaySegments.some((s) => s.kind === 'reasoning') ||
      input.displaySegments.some((s) => s.kind === 'tools'))

  const layout = buildStreamTimelineLayout({
    row: input.row,
    displaySegments: input.displaySegments,
    tools: input.tools,
    rawText: input.rawText,
    textTrimmed: !!input.textTrimmed,
    reasoningSegments: input.reasoningSegments,
    reasoningPreview: input.reasoningPreview,
    isStreaming: input.isStreaming,
    interactiveToolApproval: input.interactiveToolApproval,
    suppressPlanExecPromptNoise: input.suppressPlanExecPromptNoise,
    hasToolsInTurnEarly: input.hasToolsInTurnEarly,
    useTimelineReasoningUi,
  })

  const {
    displayChunks,
    streamTextPhase,
    firstActivityChunkIndex,
    finalReplyChunkIndex,
  } = layout

  const pendingReasoning = resolvePostToolPendingReasoning({
    isStreaming: input.isStreaming,
    displaySegments: input.displaySegments,
    displayChunks,
    reasoningPreview: input.reasoningPreview,
    tools: input.tools,
    liveTailPreviewText: layout.liveTailPreviewText,
  })

  const liveTail = resolveLiveTailSlot({
    layout,
    displaySegments: input.displaySegments,
    displayChunks,
    isStreaming: input.isStreaming,
    suppressPlanExecPromptNoise: input.suppressPlanExecPromptNoise,
    tools: input.tools,
  })

  const slots: AssistantBubbleSlot[] = []

  for (let ci = 0; ci < displayChunks.length; ci++) {
    const chunk = displayChunks[ci]
    if (chunk.kind === 'text') {
      if (
        shouldHideFinalReplyTextChunkInMap(
          ci,
          chunk.kind,
          input.isStreaming,
          streamTextPhase,
          firstActivityChunkIndex,
          finalReplyChunkIndex,
        )
      ) {
        continue
      }
    }
    slots.push(
      ...activityChunkToSlots({
        chunk,
        chunkIndex: ci,
        firstActivityChunkIndex,
        isStreaming: input.isStreaming,
      }),
    )
  }

  if (pendingReasoning) slots.push(pendingReasoning)
  if (liveTail) slots.push({ kind: 'live-tail', text: liveTail.text, isStreaming: liveTail.isStreaming })

  const fallbackFinal = resolveFinalReplyFallbackSlot({
    isStreaming: input.isStreaming,
    firstActivityChunkIndex,
    finalReplyChunkIndex,
    renderFinalReplyAtBottom: layout.renderFinalReplyAtBottom,
    liveTailPreviewText: layout.liveTailPreviewText,
    displayChunks,
    slots,
    rawText: input.rawText,
    text: input.text,
    tools: input.tools,
    suppressPlanExecPromptNoise: input.suppressPlanExecPromptNoise,
  })
  if (fallbackFinal) slots.push(fallbackFinal)

  const orphanTools = collectOrphanToolsWithoutCallId(input.tools)
  const hasActivityChunk = displayChunks.some((c) => c.kind === 'activity')
  if (orphanTools.length && (input.isStreaming || !hasActivityChunk)) {
    slots.push({ kind: 'orphan-tools', tools: orphanTools })
  }

  // 流式过程中：始终在气泡底部追加一行实时状态（思考中/正在调用工具/生成中）；
  // run 结束后由 isStreaming=false 自然移除。
  appendStreamingStatusSlot(slots, input)

  return {
    path: 'timeline',
    layout,
    slots,
    pendingReasoningSegIndex:
      pendingReasoning?.kind === 'reasoning-pending' ? pendingReasoning.segIndex : null,
  }
}

function buildPlainPlan(input: AssistantBubblePlanInput): AssistantBubbleDisplayPlan {
  const preview = String(input.reasoningPreview || '').trim()
  const reasoningForSlots =
    input.reasoningSegments.length > 0
      ? input.reasoningSegments
      : preview && input.isStreaming
        ? [preview]
        : []
  const slots: AssistantBubbleSlot[] = [
    ...topReasoningSlots(reasoningForSlots, input.isStreaming),
  ]
  const body = visibleAssistantText(
    input.plainBodyRaw,
    input.tools,
    input.suppressPlanExecPromptNoise,
    true,
  )
  if (String(body || '').trim()) {
    slots.push({ kind: 'plain-body', text: body, isStreaming: input.isStreaming })
  }
  // 流式时无条件追加状态行到气泡底部；非流式时不追加。
  appendStreamingStatusSlot(slots, input)
  return { path: 'plain', layout: null, slots, pendingReasoningSegIndex: null }
}

function buildLegacyPlan(input: AssistantBubblePlanInput): AssistantBubbleDisplayPlan {
  const slots: AssistantBubbleSlot[] = []
  if (input.legacyHasTools) slots.push({ kind: 'legacy-tools' })
  slots.push(...topReasoningSlots(input.reasoningSegments, input.isStreaming))
  if (input.legacyShowBody && input.textTrimmed) {
    slots.push({
      kind: 'legacy-body',
      text: input.text,
      isStreaming: input.isStreaming,
    })
  }
  // 流式时无条件追加状态行到气泡底部
  appendStreamingStatusSlot(slots, input)
  return { path: 'legacy', layout: null, slots, pendingReasoningSegIndex: null }
}

function resolveAgUiPlanSegments(segments: MessageSegment[]): MessageSegment[] {
  return normalizeAssistantSegmentTimelineOrder(segments)
}

function segmentsForAgUiPlan(input: AssistantBubblePlanInput): MessageSegment[] {
  let segments = resolveAgUiPlanSegments(input.displaySegments || [])
  const preview = String(input.reasoningPreview || '').trim()
  if (preview && input.isStreaming) {
    const hasReasoning = segments.some(
      (s) => s.kind === 'reasoning' && String(s.text || '').trim(),
    )
    if (!hasReasoning) {
      const hasTools = segments.some((s) => s.kind === 'tools')
      const firstText = segments.findIndex(
        (s) => s.kind === 'text' && String(s.text || '').trim(),
      )
      if (!hasTools && firstText >= 0) {
        segments = [
          ...segments.slice(0, firstText),
          { kind: 'reasoning', text: preview },
          ...segments.slice(firstText),
        ]
      } else {
        // 有工具或尚无正文：追加到末尾，保持到达序；禁止 prepend 导致思考跳到已输出工具上方。
        segments = [...segments, { kind: 'reasoning', text: preview }]
      }
    }
  }
  return segments
}

/** AG-UI 路径下把一段 text 映射成可见正文（计划/最终总结均留折叠外） */
function visibleAgUiTextSegment(
  seg: Extract<MessageSegment, { kind: 'text' }>,
  input: AssistantBubblePlanInput,
): string {
  return visiblePreToolTimelineText(
    String(seg.text || ''),
    input.suppressPlanExecPromptNoise,
    input.isStreaming,
  ).trim()
}

/** 底部 live-tail 是否已在 Exploring 折叠内的 text piece 中展示 */
export function liveTailTextCoveredByExploring(
  displayChunks: SegmentDisplayChunk[],
  liveTail: string,
): boolean {
  const live = String(liveTail || '').trim()
  if (!live) return true
  for (const chunk of displayChunks || []) {
    if (chunk.kind !== 'activity') continue
    for (const piece of chunk.pieces || []) {
      if (piece.kind !== 'text') continue
      const inner = String(piece.text || '').trim()
      if (!inner) continue
      if (inner === live || inner.includes(live) || live.includes(inner)) return true
      if (assistantBodiesLooselySame(inner, live)) return true
    }
  }
  return false
}

/**
 * AG-UI 路径：严格按 wire seq 顺序渲染，同时把「思考 + 工具 + 工具间旁白」收进单一
 * Exploring 折叠（Agent 气泡）。复用 timeline 的 seq 保序分块管线
 * （groupSegmentsForExploringDisplay），正文留在折叠内按到达顺序排列，不重排。
 */
function buildAgUiSequentialPlan(input: AssistantBubblePlanInput): AssistantBubbleDisplayPlan {
  const segments = segmentsForAgUiPlan(input)

  const layout = buildStreamTimelineLayout({
    row: input.row,
    displaySegments: segments,
    tools: input.tools,
    rawText: input.rawText,
    textTrimmed: !!input.textTrimmed,
    reasoningSegments: input.reasoningSegments,
    reasoningPreview: input.reasoningPreview,
    isStreaming: input.isStreaming,
    interactiveToolApproval: input.interactiveToolApproval,
    suppressPlanExecPromptNoise: input.suppressPlanExecPromptNoise,
    hasToolsInTurnEarly: input.hasToolsInTurnEarly,
    useTimelineReasoningUi: true,
  })

  const {
    displayChunks,
    streamTextPhase,
    firstActivityChunkIndex,
    finalReplyChunkIndex,
    liveTailPreviewText,
  } = layout

  // 续流/刷新后 rawText 常为 DB 累计全文；liveTailPreviewText 已用 streamLiveTailForDisplay 剥掉封存前缀
  const strippedTail = String(liveTailPreviewText || '').trim()
  const textChunks = displayChunks
    .map((c, i) => ({ c, i }))
    .filter((x): x is { c: Extract<SegmentDisplayChunk, { kind: 'text' }>; i: number } =>
      x.c.kind === 'text',
    )
  const lastTextChunk = textChunks[textChunks.length - 1]
  let tailRepresented = false
  // Exploring 内已有同段正文时，禁止再挂底部 live-tail（连续 AI 旁白双显）
  if (strippedTail && liveTailTextCoveredByExploring(displayChunks, strippedTail)) {
    tailRepresented = true
  }

  const slots: AssistantBubbleSlot[] = []
  for (let ci = 0; ci < displayChunks.length; ci++) {
    const chunk = displayChunks[ci]
    if (chunk.kind === 'activity' || chunk.kind === 'tools-standalone') {
      // 工具 + 思考 + 工具间旁白：收进 Exploring 折叠
      slots.push({ kind: 'chunk', chunk, chunkIndex: ci })
      continue
    }
    if (chunk.kind !== 'text') continue
    const hideForLiveTail = shouldHideFinalReplyTextChunkInMap(
      ci,
      chunk.kind,
      input.isStreaming,
      streamTextPhase,
      firstActivityChunkIndex,
      finalReplyChunkIndex,
    )
    // 仅当确有未封存后缀时才把最终正文交给 live-tail；否则继续按 plain-body 渲染，避免正文消失
    if (hideForLiveTail && strippedTail) {
      continue
    }
    const visible = visibleAgUiTextSegment(chunk, input)
    if (!visible) continue
    const isLastText = lastTextChunk != null && ci === lastTextChunk.i
    // 仅当该正文位于 Exploring 折叠之后时，才作为流式 live-tail 渲染；
    // 折叠前的正文（开场计划）保持 plain-body，避免被累计 rawText 覆盖导致重复
    const useLiveTail = !!(
      input.isStreaming &&
      isLastText &&
      strippedTail &&
      firstActivityChunkIndex >= 0 &&
      ci > firstActivityChunkIndex
    )
    if (useLiveTail) tailRepresented = true
    slots.push({
      kind: useLiveTail ? 'live-tail' : 'plain-body',
      text: useLiveTail ? strippedTail : visible,
      isStreaming: useLiveTail,
    })
  }

  // 流式期间尾部正文尚未落盘成 chunk：兜底补一行 live-tail（仅未封存后缀）
  if (input.isStreaming && strippedTail && !tailRepresented) {
    slots.push({ kind: 'live-tail', text: strippedTail, isStreaming: true })
  }

  const orphanTools = collectOrphanToolsWithoutCallId(input.tools)
  const hasActivityChunk = displayChunks.some((c) => c.kind === 'activity')
  if (orphanTools.length && (input.isStreaming || !hasActivityChunk)) {
    slots.push({ kind: 'orphan-tools', tools: orphanTools })
  }

  appendStreamingStatusSlot(slots, input)
  return { path: 'agui', layout, slots, pendingReasoningSegIndex: null }
}

function buildAgUiPlan(input: AssistantBubblePlanInput): AssistantBubbleDisplayPlan {
  return buildAgUiSequentialPlan(input)
}

/** 助手气泡唯一入口：segments + 流式状态 → path + 有序 slots */
export function buildAssistantBubbleDisplayPlan(
  input: AssistantBubblePlanInput,
): AssistantBubbleDisplayPlan {
  const path = resolveBubblePath(input)
  if (path === 'agui') return buildAgUiPlan(input)
  if (path === 'plain') return buildPlainPlan(input)
  if (path === 'legacy') return buildLegacyPlan(input)
  return buildTimelinePlan(input)
}

/** 供 layout 单测 / 旧引用：live tail 解析（委托 display-plan 策略） */
export function resolveStreamLiveTailSlotForPlan(opts: {
  layout: StreamTimelineLayout
  displaySegments: MessageSegment[]
  displayChunks: SegmentDisplayChunk[]
  isStreaming: boolean
  suppressPlanExecPromptNoise: boolean
  tools?: unknown[]
}): { kind: 'bottom' | 'fallback'; text: string; isStreaming: boolean } | null {
  const slot = resolveLiveTailSlot({ ...opts, tools: opts.tools ?? [] })
  if (!slot) return null
  const kind =
    shouldRenderFinalReplyAtBottomOnly(
      opts.layout.finalReplyChunkIndex,
      opts.layout.firstActivityChunkIndex,
    ) && opts.layout.finalReplyChunkIndex >= 0
      ? 'bottom'
      : 'fallback'
  return { kind, text: slot.text, isStreaming: slot.isStreaming }
}

export { reasoningSegmentRenderedInChunks } from './message-row-reasoning-render.js'