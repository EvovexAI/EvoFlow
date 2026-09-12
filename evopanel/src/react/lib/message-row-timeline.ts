import { insertOrphanToolsIntoSegments, normalizeAssistantSegmentTimelineOrder, toolOmitFromChatPanel } from '../../lib/chat-normalize.js'
import { dedupeToolsTimelineSegments } from './content-blocks.js'
import { isWorkerParentTool } from '../worker-file-tools.js'
import type { MessageSegment } from '../chat-types.js'

function collectSegmentToolIdSet(segments: MessageSegment[]): Set<string> {
  const out = new Set<string>()
  for (const s of segments) {
    if (s.kind !== 'tools') continue
    for (const raw of s.ids || []) {
      const id = String(raw).trim()
      if (id) out.add(id)
    }
  }
  return out
}

function toolRowIdInSegmentSet(t: unknown, segmentIds: Set<string>): boolean {
  if (!t || typeof t !== 'object') return false
  const o = t as Record<string, unknown>
  const rid = o.id != null && String(o.id).trim() !== '' ? String(o.id).trim() : ''
  const rtc =
    o.tool_call_id != null && String(o.tool_call_id).trim() !== ''
      ? String(o.tool_call_id).trim()
      : ''
  return Boolean((rid && segmentIds.has(rid)) || (rtc && segmentIds.has(rtc)))
}

function collectToolNamesAlreadySegmented(tools: unknown[], segments: MessageSegment[]): Set<string> {
  const segIds = collectSegmentToolIdSet(segments)
  const names = new Set<string>()
  for (const t of tools) {
    if (!toolRowIdInSegmentSet(t, segIds)) continue
    const o = t as Record<string, unknown>
    const nm = String(o.name || o.tool_name || o.toolName || '')
      .trim()
      .toLowerCase()
    if (nm && nm !== 'tool') names.add(nm)
  }
  return names
}

function collectOrphanToolIdsOrdered(
  tools: unknown[],
  segmentIds: Set<string>,
  namesAlreadyInSegments?: Set<string>,
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tools) {
    if (isWorkerParentTool(t)) continue
    if (toolOmitFromChatPanel(t)) continue
    if (toolRowIdInSegmentSet(t, segmentIds)) continue
    const o = t as Record<string, unknown>
    const nm = String(o.name || o.tool_name || o.toolName || '')
      .trim()
      .toLowerCase()
    if (nm && namesAlreadyInSegments?.has(nm)) continue
    const rid = o.id != null && String(o.id).trim() !== '' ? String(o.id).trim() : ''
    const rtc =
      o.tool_call_id != null && String(o.tool_call_id).trim() !== ''
        ? String(o.tool_call_id).trim()
        : ''
    const canon = rid || rtc
    if (!canon || seen.has(canon)) continue
    seen.add(canon)
    out.push(canon)
  }
  return out
}

/** 无 segments 时从 reasoning / 正文 / 工具合成最小时间线（Phase 2：避免 legacy 路径） */
export function synthesizeBaseSegmentsWhenMissing(opts: {
  segments: MessageSegment[] | undefined
  rawText?: string
  reasoningPreview?: string
}): MessageSegment[] {
  const existing = Array.isArray(opts.segments) && opts.segments.length ? [...opts.segments] : []
  if (existing.length) return existing
  const out: MessageSegment[] = []
  const reasoning = String(opts.reasoningPreview || '').trim()
  if (reasoning) out.push({ kind: 'reasoning', text: reasoning })
  const text = String(opts.rawText || '').trim()
  if (text) out.push({ kind: 'text', text })
  return out
}

/** 渲染时间线：补齐 orphan 工具段；流式仅有 tools 尚无 segments 时也合成 tools 段 */
export function mergeOrphanToolsIntoSegmentTimeline(
  segments: MessageSegment[] | undefined,
  tools: unknown[],
): MessageSegment[] {
  let timeline = Array.isArray(segments) && segments.length ? [...segments] : []
  const segmentToolIds = collectSegmentToolIdSet(timeline)
  const namesInSeg = collectToolNamesAlreadySegmented(tools, timeline)
  const orphanIds = tools.length
    ? collectOrphanToolIdsOrdered(tools, segmentToolIds, namesInSeg)
    : []
  if (orphanIds.length) {
    timeline = insertOrphanToolsIntoSegments(timeline, orphanIds)
  }
  if (!timeline.some((s) => s.kind === 'tools') && tools.length) {
    const ids = collectOrphanToolIdsOrdered(tools, new Set(), undefined)
    if (ids.length) {
      timeline = insertOrphanToolsIntoSegments(timeline, ids)
    }
  }
  return timeline
}

export function segmentsHaveAuthoritativeSeqForTimeline(segments: MessageSegment[]): boolean {
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

export function buildDisplayTimeline(
  segments: MessageSegment[] | undefined,
  tools: unknown[],
  opts?: { rawText?: string; reasoningPreview?: string },
): MessageSegment[] {
  const base = synthesizeBaseSegmentsWhenMissing({
    segments,
    rawText: opts?.rawText,
    reasoningPreview: opts?.reasoningPreview,
  })
  const merged = segmentsHaveAuthoritativeSeqForTimeline(base)
    ? dedupeToolsTimelineSegments(base)
    : mergeOrphanToolsIntoSegmentTimeline(base, tools)
  return normalizeAssistantSegmentTimelineOrder(merged)
}

/** 流式期间无 segment id 的 orphan 工具行 */
export function collectOrphanToolsWithoutCallId(tools: unknown[]): unknown[] {
  if (!tools.length) return []
  return tools.filter((t) => {
    const o = t as Record<string, unknown>
    const rid = o.id != null && String(o.id).trim() !== '' ? String(o.id).trim() : ''
    const rtc =
      o.tool_call_id != null && String(o.tool_call_id).trim() !== ''
        ? String(o.tool_call_id).trim()
        : ''
    return !rid && !rtc
  })
}

export { shouldUsePlainStreamPath } from './message-row-display-plan.js'
