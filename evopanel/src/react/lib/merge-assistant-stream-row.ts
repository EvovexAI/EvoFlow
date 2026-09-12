import type { DisplayRow, MessageSegment } from '../chat-types.js'
import { flattenStreamDisplayText } from '../../lib/chat-normalize.js'
import { mergeToolsForPlanDetection } from '../../lib/plan-pipeline.js'
import { chatRunIdsSameTurn } from './run-turn-gate.js'
import { segmentsHaveAuthoritativeSeqForTimeline } from './message-row-timeline.js'

function mergeReasoningSegments(
  assistant?: string[],
  stream?: string[],
): string[] | undefined {
  const out: string[] = []
  const seen = new Set<string>()
  for (const list of [assistant || [], stream || []]) {
    for (const raw of list) {
      const s = String(raw || '').trim()
      if (!s || seen.has(s)) continue
      seen.add(s)
      out.push(s)
    }
  }
  return out.length ? out : undefined
}

function mergeMedia<T>(assistant?: T[], stream?: T[]): T[] | undefined {
  const merged = [...(assistant || []), ...(stream || [])]
  return merged.length ? merged : undefined
}

function mergeTextFallback(assistantText: string, streamText: string): string | undefined {
  const a = String(assistantText || '').trimEnd()
  const s = String(streamText || '')
  if (!a) return s.trim() || undefined
  if (!s.trim()) return a || undefined
  const sTrim = s.trim()
  if (sTrim.startsWith(a)) return sTrim
  if (a.startsWith(sTrim)) return a
  if (s.startsWith(' ') || s.startsWith('\n') || s.startsWith('\t')) return `${a}${s}`
  const joiner = a.endsWith('\n') || s.startsWith('\n') ? '' : '\n'
  return `${a}${joiner}${s}`
}

function segmentTimelineSignature(seg: MessageSegment): string {
  if (seg.kind === 'tools') {
    return `tools:${(seg.ids || []).map((id) => String(id).trim()).filter(Boolean).join(',')}`
  }
  if (seg.kind === 'reasoning') {
    return `reasoning:${String(seg.text || '').trim()}`
  }
  return `text:${String(seg.text || '').trim()}`
}

function assistantTimelineIsPrefixOfStream(
  assistant: MessageSegment[],
  stream: MessageSegment[],
): boolean {
  if (!assistant.length) return stream.length > 0
  if (stream.length < assistant.length) return false
  for (let i = 0; i < assistant.length; i++) {
    if (segmentTimelineSignature(assistant[i]) !== segmentTimelineSignature(stream[i])) {
      return false
    }
  }
  return true
}

function mergeSegmentTimeline(
  assistant?: MessageSegment[],
  stream?: MessageSegment[],
): MessageSegment[] | undefined {
  const a = Array.isArray(assistant) ? assistant : []
  const s = Array.isArray(stream) ? stream : []
  if (!a.length && !s.length) return undefined
  if (!a.length) return [...s]
  if (!s.length) return [...a]
  if (assistantTimelineIsPrefixOfStream(a, s)) return [...s]
  if (assistantTimelineIsPrefixOfStream(s, a)) return [...a]
  return [...a, ...s]
}

function resolveMergedStreamTailDedupeSegments(
  stream: DisplayRow,
  mergedSegments?: MessageSegment[],
): MessageSegment[] | undefined {
  if (stream.streamTailDedupeSegments?.length) {
    return stream.streamTailDedupeSegments
  }
  return mergedSegments?.length ? mergedSegments : undefined
}

export type StreamContinuationOpts = {
  hostedGoalSameRun?: boolean
  resumeAttachSameRun?: boolean
  /** 同 run 仍在流式：工具阶段中间落库带 duration/token 时须继续合并，避免双气泡 */
  liveStreamSameRun?: boolean
}

/** 仅用户停止后的 partial assistant 可与续流合并；已完成的上一轮回复始终单独展示。 */
export function assistantRowAcceptsStreamContinuation(
  row: DisplayRow | undefined,
  streamRunId?: string | null,
  opts?: StreamContinuationOpts,
): boolean {
  if (row?.role !== 'assistant') return false
  const rowRun = String(row.runId || '').trim()
  const liveRun = String(streamRunId || '').trim()
  // Tool-approval pause seals incompleteStream; client_stream_replay starts a new runId —
  // still continue the same bubble (ignore runId mismatch).
  if (row.incompleteStream === true) return true
  if (rowRun && liveRun && rowRun !== liveRun && !chatRunIdsSameTurn(rowRun, liveRun)) return false
  // 续流 attach：同 run 活跃会话切回/刷新，须合并到同一气泡，避免 separate _stream pin。
  if (opts?.resumeAttachSameRun && rowRun && liveRun && rowRun === liveRun) return true
  // Goal 模式同 run 内 middleware 续跑：上一轮已落库为「终态」气泡，续流仍应合并到同一 AI 回复。
  if (opts?.hostedGoalSameRun && rowRun && liveRun && rowRun === liveRun) return true
  // 同 run 活跃流式：正常 POST run 与续流 attach 均须合并（含 client UUID ↔ wire run 双 id）。
  // runId 已清空（final 后）时不续合并，避免空 stream 覆盖已落库 assistant。
  if (opts?.liveStreamSameRun) {
    if (!liveRun) return false
    if (!rowRun || rowRun === liveRun || chatRunIdsSameTurn(rowRun, liveRun)) return true
  }
  return false
}

function streamBodyCoversAssistant(assistant: DisplayRow, stream: DisplayRow): boolean {
  const aBody = flattenStreamDisplayText(assistant.segments, assistant.text).trim()
  const sBody = flattenStreamDisplayText(stream.segments, stream.text).trim()
  if (!aBody) return !!sBody
  if (!sBody) return false
  if (sBody.startsWith(aBody)) return true
  const aNorm = aBody.replace(/\s+/g, ' ')
  const sNorm = sBody.replace(/\s+/g, ' ')
  return sNorm.length >= aNorm.length && sNorm.includes(aNorm)
}

function shouldPreferStreamTimeline(assistant: DisplayRow, stream: DisplayRow): boolean {
  if (streamBodyCoversAssistant(assistant, stream)) return true
  const a = Array.isArray(assistant.segments) ? assistant.segments : []
  const s = Array.isArray(stream.segments) ? stream.segments : []
  return assistantTimelineIsPrefixOfStream(a, s)
}

function collectToolIdsFromRow(row: DisplayRow | undefined | null): Set<string> {
  const ids = new Set<string>()
  if (!row) return ids
  for (const t of row.tools || []) {
    const o = t as Record<string, unknown>
    const id = String(o.id || o.tool_call_id || '').trim()
    if (id) ids.add(id)
  }
  for (const seg of row.segments || []) {
    if (seg.kind !== 'tools') continue
    for (const raw of seg.ids || []) {
      const id = String(raw || '').trim()
      if (id) ids.add(id)
    }
  }
  return ids
}

/** stream 时间线若自称是 incomplete 的超集，必须仍包含 assistant 已有工具，否则会把 read 等已展示步骤吞掉 */
function streamPreservesAssistantToolIds(assistant: DisplayRow, stream: DisplayRow): boolean {
  const need = collectToolIdsFromRow(assistant)
  if (!need.size) return true
  const have = collectToolIdsFromRow(stream)
  for (const id of need) {
    if (!have.has(id)) return false
  }
  return true
}

/** 刷新后续流：把已落库 assistant 与内存 _stream 合成同一气泡展示，避免双行间距。 */
export function mergeAssistantRowWithStreamRow(
  assistant: DisplayRow,
  stream: DisplayRow,
): DisplayRow {
  // incomplete（工具审批暂停）后续流常是新 run：默认拼接时间线；若 stream 已是超集则沿用 stream。
  const forceMergeTimeline = assistant.incompleteStream === true
  const aSegs = Array.isArray(assistant.segments) ? assistant.segments : []
  const sSegs = Array.isArray(stream.segments) ? stream.segments : []
  const streamExtendsIncomplete =
    forceMergeTimeline &&
    sSegs.length > 0 &&
    assistantTimelineIsPrefixOfStream(aSegs, sSegs) &&
    streamPreservesAssistantToolIds(assistant, stream)
  const preferStreamTimeline =
    streamExtendsIncomplete ||
    (!forceMergeTimeline && shouldPreferStreamTimeline(assistant, stream))
  const segments = preferStreamTimeline
    ? stream.segments?.length
      ? stream.segments
      : assistant.segments
    : mergeSegmentTimeline(assistant.segments, stream.segments)
  const streamTailDedupeSegments = resolveMergedStreamTailDedupeSegments(stream, segments)
  const tools = mergeToolsForPlanDetection(assistant.tools || [], stream.tools || [])

  const resolveMergedReasoningPreview = (): string | null | undefined => {
    const sp = stream.reasoningPreview
    if (sp != null && String(sp).trim()) return sp
    // stream 已有自己的时间线时，勿回落 sealed assistant.reasoningPreview：
    // 否则仅含新工具的 live 段会把首段 Thinking 再插到最新工具下方。
    if (Array.isArray(stream.segments) && stream.segments.length > 0) {
      return sp == null ? null : sp
    }
    return assistant.reasoningPreview
  }

  if (preferStreamTimeline) {
    // 正文已在 segments：禁止回落 DB assistant.text（刷新后续流常为多段拼接全文 → 底部 live-tail 重复）
    const streamOwnsBody =
      !!stream.segments?.some((s) => s.kind === 'text' && String(s.text || '').trim()) ||
      !!stream.aguiTurn
    return {
      ...assistant,
      role: 'assistant',
      text: streamOwnsBody ? String(stream.text || '') : stream.text || assistant.text,
      segments,
      tools,
      reasoningPreview: resolveMergedReasoningPreview(),
      reasoningSegments: stream.reasoningSegments?.length
        ? stream.reasoningSegments
        : assistant.reasoningSegments,
      streamTextPhase: stream.streamTextPhase ?? assistant.streamTextPhase,
      systemActivity: stream.systemActivity ?? assistant.systemActivity,
      tokenStr: stream.tokenStr || assistant.tokenStr,
      streamTailDedupeSegments,
      subagentTasks: stream.subagentTasks ?? assistant.subagentTasks,
      terminalStreams: stream.terminalStreams ?? assistant.terminalStreams,
      images: stream.images?.length ? stream.images : assistant.images,
      videos: stream.videos?.length ? stream.videos : assistant.videos,
      audios: stream.audios?.length ? stream.audios : assistant.audios,
      files: stream.files?.length ? stream.files : assistant.files,
      ...(stream.aguiTurn ? { aguiTurn: stream.aguiTurn } : {}),
    }
  }

  const hasSegText = !!segments?.some((s) => s.kind === 'text' && String(s.text || '').trim())
  const text = segments?.length
    ? forceMergeTimeline && hasSegText
      ? String(stream.text || '')
      : stream.text || assistant.text
    : mergeTextFallback(String(assistant.text || ''), String(stream.text || ''))

  return {
    ...assistant,
    role: 'assistant',
    text,
    segments,
    tools,
    reasoningPreview: resolveMergedReasoningPreview(),
    reasoningSegments: mergeReasoningSegments(
      assistant.reasoningSegments,
      stream.reasoningSegments,
    ),
    streamTextPhase: stream.streamTextPhase ?? assistant.streamTextPhase,
    systemActivity: stream.systemActivity ?? assistant.systemActivity,
    tokenStr: stream.tokenStr || assistant.tokenStr,
    streamTailDedupeSegments,
    subagentTasks: stream.subagentTasks ?? assistant.subagentTasks,
    terminalStreams: stream.terminalStreams ?? assistant.terminalStreams,
    images: mergeMedia(assistant.images, stream.images),
    videos: mergeMedia(assistant.videos, stream.videos),
    audios: mergeMedia(assistant.audios, stream.audios),
    files: mergeMedia(assistant.files, stream.files),
    ...(stream.aguiTurn ? { aguiTurn: stream.aguiTurn } : {}),
  }
}

function assistantHasAuthoritativeSegmentTimeline(row: DisplayRow): boolean {
  return segmentsHaveAuthoritativeSeqForTimeline(Array.isArray(row.segments) ? row.segments : [])
}

/** final 落库前：把内存 stream 可见正文合并进 assistant 行，避免清 stream 后气泡变短、滚动跳中间。 */
export function mergeStreamSnapIntoAssistantRow(
  assistant: DisplayRow,
  streamSnap: DisplayRow | null | undefined,
): DisplayRow {
  if (!streamSnap) return assistant
  if (assistantHasAuthoritativeSegmentTimeline(assistant)) return assistant
  const merged = mergeAssistantRowWithStreamRow(assistant, streamSnap)
  return {
    ...merged,
    role: 'assistant',
    durationStr: assistant.durationStr ?? merged.durationStr,
    tokenStr: assistant.tokenStr ?? merged.tokenStr,
    incompleteStream: assistant.incompleteStream,
    timestamp: assistant.timestamp,
    runId: assistant.runId ?? merged.runId,
  }
}
