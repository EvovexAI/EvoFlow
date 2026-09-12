import { isToolCallPreambleAssistantNoise } from '../../lib/assistant-display-noise.js'
import { isPlanExecPromptAssistantNoise } from '../../lib/plan-exec-ui.js'
import {
  assistantBodiesLooselySame,
  stripLegacyEmbeddedReasoningPrefix,
  stripStructuredToolSummaryFromDisplayText,
  trimAssistantBubbleMarkdown,
} from '../../lib/chat-normalize.js'
import { stripAskClarificationLeakFromDisplayText } from './clarify-chat-display.js'
import { stripEvoAssetCitations } from './evo-asset-citation.js'

export function dedupeConsecutiveParagraphs(text: string): string {
  const raw = String(text || '').trim()
  if (!raw) return ''
  const parts = raw.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  const out: string[] = []
  for (const part of parts) {
    const prev = out[out.length - 1]
    if (prev && assistantBodiesLooselySame(prev, part)) continue
    out.push(part)
  }
  return out.join('\n\n')
}

export function bubbleMarkdownText(raw: string): string {
  return trimAssistantBubbleMarkdown(raw)
}

export function visibleAssistantText(
  raw: string,
  tools: unknown[],
  suppressPlanExecPrompt?: boolean,
  isStreaming?: boolean,
): string {
  let text = stripLegacyEmbeddedReasoningPrefix(String(raw || ''))
  if (suppressPlanExecPrompt && isPlanExecPromptAssistantNoise(text)) return ''
  if (isToolCallPreambleAssistantNoise(text, tools)) return ''
  if (isStreaming) text = stripStructuredToolSummaryFromDisplayText(text)
  text = stripAskClarificationLeakFromDisplayText(text, tools)
  // Citation XML is for chips / deep-links — hide from markdown bubble
  if (!isStreaming) text = stripEvoAssetCitations(text)
  return text
}

/** 流式首段：优先取完整首句，便于思考进行中先露出一句澄清 */
export function extractOpeningClarificationSentence(raw: string): string {
  const text = stripLegacyEmbeddedReasoningPrefix(String(raw || '')).trim()
  if (!text) return ''
  const firstPara = text.split(/\n{2,}/)[0]?.trim() || text
  const sentence = firstPara.match(/^[\s\S]*?[。！？!?]/)
  if (sentence?.[0]?.trim()) return sentence[0].trim()
  const firstLine = firstPara.split('\n')[0]?.trim() || ''
  if (firstLine.length >= 6) return firstLine
  return firstPara.length <= 200 ? firstPara : ''
}

/** 顶栏计划段：保留开场计划/激活说明，不走 tool-call preamble 过滤 */
export function planTopDisplayText(
  raw: string,
  suppressPlanExecPrompt?: boolean,
  opts?: { streamingPreview?: boolean },
): string {
  const text = stripLegacyEmbeddedReasoningPrefix(String(raw || ''))
  if (suppressPlanExecPrompt && isPlanExecPromptAssistantNoise(text)) return ''
  if (opts?.streamingPreview) {
    const opening = extractOpeningClarificationSentence(text)
    if (opening) return opening
  }
  return dedupeConsecutiveParagraphs(text)
}

/** 时间线在首个 Exploring 之前的正文：按到达顺序展示，勿用同轮 tools 做 preamble 过滤 */
export function visiblePreToolTimelineText(
  raw: string,
  suppressPlanExecPrompt?: boolean,
  isStreaming?: boolean,
): string {
  return visibleAssistantText(raw, [], suppressPlanExecPrompt, isStreaming)
}

/** Exploring 内工具间正文：保留旁白，仅去掉计划确认等噪声 */
export function visibleExploringInnerText(
  raw: string,
  suppressPlanExecPrompt?: boolean,
  isStreaming?: boolean,
  tools?: unknown[],
): string {
  let text = stripLegacyEmbeddedReasoningPrefix(String(raw || ''))
  if (suppressPlanExecPrompt && isPlanExecPromptAssistantNoise(text)) return ''
  if (isStreaming) text = stripStructuredToolSummaryFromDisplayText(text)
  text = stripAskClarificationLeakFromDisplayText(text, tools)
  if (!isStreaming) text = stripEvoAssetCitations(text)
  return text
}
