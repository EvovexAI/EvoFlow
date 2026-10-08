/**
 * ChatApp.tsx module-顶层 helper 集合（v3.5 阶段 F2 commit 1 抽出）。
 *
 * 主题：**segments** —— display segments (MessageSegment[]) 的纯函数
 * 操作:查 text body 存在 / 工具后是否还有正文 / 是否交错工具 /
 * 按 seq 排序 / 按 id 去重 / 把 authoritative 段落合并进 finalize 结果 /
 * 从 wire payload 重建 finalize 结果。
 *
 * 这些函数以前散在 ChatApp.tsx 614-715 行,实现密集团队内复用较多
 * (mergeAuthoritativeDisplaySegments / authoritativeFinalFromPayload
 * 是 stream turn 收尾时的必经路径),抽出来后 ChatApp.tsx 顶部
 * helper 区不再"挡视线"。
 */
import { enforceSegmentDisplayOrder } from '../../lib/content-blocks.js'
import { finalizeStreamTurn } from '../../lib/stream-turn-engine.js'
import type { MessageSegment } from '../../chat-types.js'

/** 段序列里是否含任何"有正文"的 text 段(text.trim() 非空)。 */
export function segmentTimelineHasTextBody(segments: MessageSegment[] | undefined): boolean {
  return !!(segments || []).some(
    (s) => s.kind === 'text' && String((s as { text?: string }).text || '').trim(),
  )
}

/** 工具段之后是否还有正文(值班总结等);仅有工具前 plan 不算。 */
export function segmentTimelineHasPostToolText(segments: MessageSegment[] | undefined): boolean {
  const list = segments || []
  let lastTools = -1
  for (let i = 0; i < list.length; i++) {
    if (list[i]?.kind === 'tools') lastTools = i
  }
  if (lastTools < 0) return false
  return list
    .slice(lastTools + 1)
    .some((s) => s.kind === 'text' && String((s as { text?: string }).text || '').trim())
}

/** 段序列里是否含 tools 段(判断"交错工具流"用)。 */
export function segmentTimelineHasInterleavedTools(segments: MessageSegment[] | undefined): boolean {
  return !!(segments || []).some((s) => s.kind === 'tools')
}

/** 按 seq 排好(供 merge 前对齐,避免后续 compare 误判)。 */
export function sortSegmentsBySeqIfPresent(segments: MessageSegment[]): MessageSegment[] {
  return enforceSegmentDisplayOrder(segments)
}

/** 按 id / seq 去重,保留首次出现的(合并多源时防重)。 */
export function dedupSegmentsById(segments: MessageSegment[]): MessageSegment[] {
  const seen = new Set<string>()
  const out: MessageSegment[] = []
  for (const s of segments) {
    const key = String(s.id || s.seq || '').trim()
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    out.push(s)
  }
  return out
}

/**
 * 合并 "finalizeStreamTurn 算出的 segments" 和 "wire 推上来的 authoritative
 * segments"。规则:
 *  - authoritative 为空 → 用 finalize
 *  - authoritative 有 text + 无 tools 但 finalize 有 tools + text → 用 finalize
 *    (Payload snapshot often has reasoning+text but omits interleaved tools;
 *     保留 live timeline)
 *  - authoritative 无 text 但 finalize 有 text → 把 finalize 的 text 段追加
 *  - authoritative 有 text → 用 authoritative
 *  - 否则用两者任一非空者
 */
export function mergeAuthoritativeDisplaySegments(
  fin: ReturnType<typeof finalizeStreamTurn>,
  authSegsRaw: MessageSegment[],
): MessageSegment[] {
  const authSegs = dedupSegmentsById(sortSegmentsBySeqIfPresent(authSegsRaw))
  if (!authSegs.length) return dedupSegmentsById(fin.segments || [])
  const finSegs = dedupSegmentsById(sortSegmentsBySeqIfPresent(fin.segments || []))

  const authHasText = segmentTimelineHasTextBody(authSegs)
  const finHasText = segmentTimelineHasTextBody(finSegs)
  const authHasTools = segmentTimelineHasInterleavedTools(authSegs)
  const finHasTools = segmentTimelineHasInterleavedTools(finSegs)

  // Payload snapshot often has reasoning+text but omits interleaved tools; keep live timeline.
  if (authHasText && !authHasTools && finHasTools && finHasText) {
    return finSegs
  }

  if (!authHasText && finHasText) {
    const textSegs = finSegs.filter((s) => s.kind === 'text')
    return sortSegmentsBySeqIfPresent([...authSegs, ...textSegs])
  }
  if (authHasText) return authSegs
  if (finSegs.length) return finSegs
  return authSegs
}

/**
 * 从 wire payload 重建 finalizeStreamTurn 结果,把 displaySegments /
 * reasoningSegments / reasoningPreview / message.text 都做权威覆盖。
 */
export function authoritativeFinalFromPayload(
  fin: ReturnType<typeof finalizeStreamTurn>,
  payload: Record<string, unknown>,
): ReturnType<typeof finalizeStreamTurn> {
  const authSegsRaw = payload.displaySegments ?? payload.display_segments
  if (
    !Array.isArray(authSegsRaw) ||
    !authSegsRaw.length ||
    !authSegsRaw.every((s) => s && typeof (s as MessageSegment).seq === 'number')
  ) {
    return fin
  }
  const reasoningSegments = Array.isArray(payload.reasoningSegments)
    ? (payload.reasoningSegments as string[]).map((s) => String(s || '')).filter(Boolean)
    : fin.reasoningSegments
  const reasoningPreview =
    typeof payload.reasoningPreview === 'string' && payload.reasoningPreview.trim()
      ? payload.reasoningPreview.trim()
      : fin.reasoningPreview
  const mergedSegments = mergeAuthoritativeDisplaySegments(fin, authSegsRaw as MessageSegment[])
  const payloadText = String(
    (payload.message as { content?: Array<{ type?: string; text?: string }> } | undefined)
      ?.content?.find((c) => c?.type === 'text')
      ?.text || '',
  ).trim()
  const textOut =
    fin.text ||
    (!segmentTimelineHasTextBody(mergedSegments) && payloadText ? payloadText : fin.text)
  return {
    ...fin,
    segments: mergedSegments,
    text: textOut,
    reasoningSegments,
    reasoningPreview,
  }
}
