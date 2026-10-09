import type { StreamState } from '../chat-types.js'
import type { DisplayRow, MessageSegment } from '../chat-types.js'
import type { AgUiTurnState } from './agui-turn-reducer.js'
import { projectAgUiToStreamTurnFields, timelineWithOpenAgUiReasoning, timelineWithOpenAgUiAssistantText } from './agui-turn-reducer.js'
import { normalizeAssistantSegmentTimelineOrder } from '../../lib/chat-normalize.js'
import { streamRefHasVisibleContent } from './stream-state.js'
import { emptyStreamTurn, mergeCompactedPartsIntoTurn, projectStreamTurn } from './stream-turn-engine.js'
import {
  collectToolCallIdsFromToolList,
  filterSubagentTasksForToolIds,
  filterTerminalStreamsForToolIds,
  isolateStreamProjection,
  sanitizeLiveStreamDisplayFields,
  type PriorTurnStripBundle,
} from './turn-text-isolation.js'
import { EMPTY_PRIOR_TURN_STRIP } from './session-runtime-store.js'
import { SESSION_RUNNING_ACTIVITY_LABEL } from './resolve-live-stream-activity.js'
import { logStreamCompareAgUiInternals } from './stream-compare-file-log.js'
import {
  liveStreamDisplayTail,
  STREAM_PLAIN_DISPLAY_MAX_CHARS,
  STREAM_REASONING_DISPLAY_MAX_CHARS,
} from './markdown-stream-paint.js'

export type StreamRowState = 'streaming' | 'closed'

/**
 * Tail-window the trailing open text + reasoning segment of a streaming row so
 * React/Markdown DOM stay bounded. The full body still lives in aguiTurn/turn
 * for tool-call, copy, finalize. Closed rows are never tailed (markdown renders
 * the whole body).
 *
 * This replaces the old ``applyLiveStreamOverlay`` external store path.
 */
function tailWindowOpenSegments(
  segments: MessageSegment[] | undefined,
  state: StreamRowState,
): MessageSegment[] | undefined {
  if (!Array.isArray(segments) || !segments.length || state !== 'streaming') return segments
  const out = segments.slice()
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const seg = out[i]
    if (!seg) continue
    if (seg.kind === 'text') {
      const tailed = liveStreamDisplayTail(String(seg.text || ''), STREAM_PLAIN_DISPLAY_MAX_CHARS)
      if (tailed === seg.text) break
      out[i] = { ...seg, text: tailed }
      break
    }
    if (seg.kind === 'reasoning') {
      const tailed = liveStreamDisplayTail(
        String(seg.text || ''),
        STREAM_REASONING_DISPLAY_MAX_CHARS,
      )
      if (tailed === seg.text) break
      out[i] = { ...seg, text: tailed }
      break
    }
  }
  return out
}

function turnStateForStreamDisplay(s: StreamState) {
  if (s.aguiTurn) {
    const agui = projectAgUiToStreamTurnFields(s.aguiTurn)
    const liveTimeline = timelineWithOpenAgUiReasoning(
      timelineWithOpenAgUiAssistantText(agui.timeline, s.aguiTurn),
      s.aguiTurn,
    )
    const merged = mergeCompactedPartsIntoTurn(s.compactedParts || [], {
      ...emptyStreamTurn(),
      timeline: liveTimeline,
      openText: agui.openText,
      tools: agui.tools,
      systemActivity: agui.systemActivity ?? s.turn.systemActivity,
      systemActivityKind: s.turn.systemActivityKind,
      systemActivityStartedAt: s.turn.systemActivityStartedAt,
      phaseHistory: s.turn.phaseHistory,
      images: s.turn.images,
      videos: s.turn.videos,
      audios: s.turn.audios,
      files: s.turn.files,
      textPhase: s.turn.textPhase,
      blocks: {},
      blockOrder: [],
    })
    return { ...merged, timeline: normalizeAssistantSegmentTimelineOrder(merged.timeline) }
  }
  return mergeCompactedPartsIntoTurn(s.compactedParts || [], s.turn)
}

type RowBuildCache = {
  structuralKey: string
  metaKey: string
  textLen: number
  reasoningLen: number
  row: DisplayRow | null
}

const rowBuildCache = new WeakMap<StreamState, RowBuildCache>()

function priorStripKey(strip: PriorTurnStripBundle): string {
  return `${strip.body.length}|${strip.reasoning.length}|${(strip.toolIds || []).length}`
}

/**
 * Write-body tokens update ``_writeProgress`` without changing tools.length /
 * toolCalls.size / textLen. Without this fingerprint the row cache freezes the
 * first progress snapshot (inline KB + diff modal stuck).
 */
function writeProgressFingerprint(s: StreamState): string {
  const parts: string[] = []
  const pushWp = (id: string, wp: Record<string, unknown> | undefined) => {
    if (!wp) return
    const len =
      typeof wp.content_len === 'number' && Number.isFinite(wp.content_len)
        ? wp.content_len
        : typeof wp.content === 'string'
          ? wp.content.length
          : 0
    const bw =
      typeof wp.bytes_written === 'number' && Number.isFinite(wp.bytes_written)
        ? wp.bytes_written
        : 0
    const phase = typeof wp.phase === 'string' ? wp.phase : ''
    const added = Number(wp.lines_added) || 0
    const removed = Number(wp.lines_removed) || 0
    // Path often arrives after the first content delta; include it so the live
    // tool-row brief can refresh from "…" to the target filename.
    const path = typeof wp.path === 'string' ? wp.path.trim() : ''
    if (!len && !bw && !phase && !added && !removed && !path) return
    parts.push(`${id}:${phase}:${len}:${bw}:${added}:${removed}:${path}`)
  }
  if (s.aguiTurn) {
    for (const tc of s.aguiTurn.toolCalls.values()) {
      pushWp(
        tc.toolCallId,
        tc._writeProgress && typeof tc._writeProgress === 'object'
          ? (tc._writeProgress as Record<string, unknown>)
          : undefined,
      )
    }
  } else {
    for (const raw of s.turn.tools || []) {
      const row = raw as Record<string, unknown>
      const id = String(row.id ?? row.tool_call_id ?? '').trim()
      if (!id) continue
      pushWp(
        id,
        row._writeProgress && typeof row._writeProgress === 'object'
          ? (row._writeProgress as Record<string, unknown>)
          : undefined,
      )
    }
  }
  return parts.join('|')
}

function structuralKey(s: StreamState): string {
  const turn = s.turn
  const agui = s.aguiTurn
  return [
    s.runId ?? '',
    s.compactedParts?.length ?? 0,
    turn.tools?.length ?? 0,
    turn.systemActivity ?? '',
    turn.systemActivityKind ?? '',
    turn.textPhase ?? '',
    turn.images?.length ?? 0,
    turn.videos?.length ?? 0,
    turn.audios?.length ?? 0,
    turn.files?.length ?? 0,
    Object.keys(s.subagentTasks || {}).length,
    Object.keys(s.terminalStreams || {}).length,
    writeProgressFingerprint(s),
    agui
      ? `${agui.runId}|${agui.order.length}|${agui.toolCalls.size}|${agui.compatSegments.length}|${agui.compatTools.length}|${String(agui.activity ?? '')}|${agui.finished ? 1 : 0}`
      : '',
  ].join('\0')
}

function cheapAgUiTextLens(agui: AgUiTurnState): { textLen: number; reasoningLen: number } {
  const openTextMsgs = [...agui.messages.values()].filter((m) => !m.closed && m.role === 'assistant')
  const textLen = openTextMsgs.length ? openTextMsgs[openTextMsgs.length - 1].content.length : 0
  const lastReasoningId = [...agui.order].reverse().find((e) => e.kind === 'reasoning')?.messageId
  const openReasoning = lastReasoningId ? agui.messages.get(lastReasoningId) : undefined
  const reasoningLen = openReasoning ? openReasoning.content.length : 0
  return { textLen, reasoningLen }
}

function metaKey(
  liveTurnTokenStr: string,
  suppressStreamFiles: boolean,
  isSending: boolean,
  priorTurnStrip: PriorTurnStripBundle,
): string {
  return `${liveTurnTokenStr}\0${suppressStreamFiles}\0${isSending}\0${priorStripKey(priorTurnStrip)}`
}

function readTextReasoningLens(s: StreamState): { textLen: number; reasoningLen: number } {
  if (s.aguiTurn) return cheapAgUiTextLens(s.aguiTurn)
  const proj = projectStreamTurn(s.turn)
  return {
    textLen: String(proj.text || '').length,
    reasoningLen: String(proj.reasoningPreview || '').length,
  }
}

function resolveStreamRowState(s: StreamState): StreamRowState {
  let result: StreamRowState
  if (s.aguiTurn) {
    result = s.aguiTurn.finished ? 'closed' : 'streaming'
    console.log(
      `[GearDebug] resolveStreamRowState AG-UI: finished=${s.aguiTurn.finished} → state="${result}"`,
      '| runId:', s.runId,
      '| timeline items:', s.aguiTurn.timeline?.length ?? 0,
      '| openText len:', s.aguiTurn.openText?.length ?? 0,
    )
    return result
  }
  // Legacy path: agui absent means reducer already sealed at finalizeStreamTurn.
  if (s.turn.timeline.length > 0 || s.turn.openText) {
    result = 'closed'
    console.log(
      `[GearDebug] resolveStreamRowState Legacy→closed:`,
      '| timeline.length:', s.turn.timeline.length,
      '| openText:', s.turn.openText?.slice(0, 50),
    )
    return result
  }
  result = 'streaming'
  console.log(
    `[GearDebug] resolveStreamRowState Legacy→streaming:`,
    '| timeline.length:', s.turn.timeline.length,
  )
  return result
}

function finalizeStreamRow(
  s: StreamState,
  p: ReturnType<typeof isolateStreamProjection>,
  priorTurnStrip: PriorTurnStripBundle,
  liveTurnTokenStr: string,
  suppressStreamFiles: boolean,
  isSending: boolean,
): DisplayRow {
  const cleaned = sanitizeLiveStreamDisplayFields(
    {
      text: p.text,
      reasoningPreview: p.reasoningPreview,
      reasoningSegments: [...p.reasoningSegments],
    },
    priorTurnStrip,
  )
  p.text = cleaned.text
  p.reasoningPreview = cleaned.reasoningPreview
  p.reasoningSegments = cleaned.reasoningSegments
  const resolvedActivity =
    String(p.systemActivity || '').trim() || (isSending ? SESSION_RUNNING_ACTIVITY_LABEL : null)
  const liveToolIds = collectToolCallIdsFromToolList(p.tools)
  const st = filterSubagentTasksForToolIds(s.subagentTasks, liveToolIds)
  const tt = filterTerminalStreamsForToolIds(s.terminalStreams, liveToolIds)
  const state = resolveStreamRowState(s)
  // 旧 applyLiveStreamOverlay 的职责：仅在 streaming 时把最后一段 text/reasoning 做 tail-windowing
  const segments = tailWindowOpenSegments(p.segments, state)
  const runId = String(s.runId || '').trim() || undefined
  return {
    role: '_stream',
    state,
    ...(runId ? { runId } : {}),
    text: p.text,
    reasoningPreview: p.reasoningPreview,
    reasoningSegments: p.reasoningSegments,
    segments,
    streamTailDedupeSegments: segments,
    tools: p.tools,
    streamTextPhase: p.streamTextPhase,
    systemActivity: resolvedActivity,
    tokenStr: liveTurnTokenStr || undefined,
    images: p.images,
    videos: p.videos,
    audios: p.audios,
    files: suppressStreamFiles ? [] : p.files,
    ...(st ? { subagentTasks: st } : {}),
    ...(tt ? { terminalStreams: tt } : {}),
    ...(s.aguiTurn ? { aguiTurn: s.aguiTurn } : {}),
  }
}

/**
 * Build the live `_stream` display row from the current in-memory stream snapshot.
 *
 * Single source of truth: tail-windowing and ``state`` are computed here so the
 * downstream ``MessageRow`` is a pure consumer. Cache key is structural+meta+lens
 * — same key returns the same row reference (stable for React).
 */
export function buildStreamDisplayRow(
  streamSnapshot: StreamState | null | undefined,
  liveTurnTokenStr: string,
  suppressStreamFiles: boolean,
  isSending: boolean,
  priorTurnStrip: PriorTurnStripBundle = EMPTY_PRIOR_TURN_STRIP,
  sessionKey?: string,
): DisplayRow | null {
  const s = streamSnapshot
  if (!s) return null
  const sk = structuralKey(s)
  const mk = metaKey(liveTurnTokenStr, suppressStreamFiles, isSending, priorTurnStrip)
  const { textLen, reasoningLen } = readTextReasoningLens(s)
  const cached = rowBuildCache.get(s)

  if (
    cached &&
    cached.structuralKey === sk &&
    cached.metaKey === mk &&
    cached.textLen === textLen &&
    cached.reasoningLen === reasoningLen &&
    cached.row
  ) {
    return cached.row
  }

  const activityLabel = String(s.turn.systemActivity || '').trim() || null
  const aguiProj = s.aguiTurn ? projectAgUiToStreamTurnFields(s.aguiTurn) : null
  const hasContent = streamRefHasVisibleContent(s)
  if (!hasContent) {
    if (!isSending) {
      rowBuildCache.delete(s)
      return null
    }
    const resolvedRunId =
      String(s.runId || '').trim() ||
      String(s.aguiTurn?.runId || '').trim() ||
      undefined
    const placeholderFields = sanitizeLiveStreamDisplayFields(
      {
        text: String(aguiProj?.openText || '').trim(),
        reasoningPreview: String(aguiProj?.reasoningPreview || '').trim() || null,
        reasoningSegments: aguiProj?.reasoningSegments?.length ? aguiProj.reasoningSegments : [],
      },
      priorTurnStrip,
    )
    const row: DisplayRow = {
      role: '_stream',
      state: 'streaming',
      ...(resolvedRunId ? { runId: resolvedRunId } : {}),
      text: placeholderFields.text,
      reasoningPreview: placeholderFields.reasoningPreview || undefined,
      reasoningSegments: placeholderFields.reasoningSegments.length
        ? placeholderFields.reasoningSegments
        : undefined,
      tools: [],
      systemActivity:
        activityLabel ||
        String(aguiProj?.systemActivity || '').trim() ||
        (isSending ? SESSION_RUNNING_ACTIVITY_LABEL : null),
      streamTextPhase: 'pre_tools',
      ...(s.aguiTurn ? { aguiTurn: s.aguiTurn } : {}),
    }
    rowBuildCache.set(s, { structuralKey: sk, metaKey: mk, textLen, reasoningLen, row })
    return row
  }

  if (
    cached &&
    cached.structuralKey === sk &&
    cached.metaKey === mk &&
    cached.row &&
    textLen >= cached.textLen &&
    reasoningLen >= cached.reasoningLen
  ) {
    // 纯文本/纯推理增量：复用 cached.row，仅就地 mutate 文本类字段。
    // 这样下游 React.memo 可以基于 row 引用相等跳过整树重渲染，避免每条 SSE
    // delta 让 MessageRow/AssistantBody/工具列表整树重渲造成视觉抖动。
    const p = isolateStreamProjection(turnStateForStreamDisplay(s), priorTurnStrip)
    const cleaned = sanitizeLiveStreamDisplayFields(
      {
        text: p.text,
        reasoningPreview: p.reasoningPreview,
        reasoningSegments: [...p.reasoningSegments],
      },
      priorTurnStrip,
    )
    const state = resolveStreamRowState(s)
    const segments = tailWindowOpenSegments(p.segments, state)
    const resolvedActivity =
      String(p.systemActivity || '').trim() || (isSending ? SESSION_RUNNING_ACTIVITY_LABEL : null)
    const liveToolIds = collectToolCallIdsFromToolList(p.tools)
    const st = filterSubagentTasksForToolIds(s.subagentTasks, liveToolIds)
    const tt = filterTerminalStreamsForToolIds(s.terminalStreams, liveToolIds)
    const row = cached.row
    row.text = cleaned.text
    row.reasoningPreview = cleaned.reasoningPreview
    row.reasoningSegments = cleaned.reasoningSegments
    row.segments = segments
    row.streamTailDedupeSegments = segments
    row.tools = p.tools
    row.streamTextPhase = p.streamTextPhase
    row.systemActivity = resolvedActivity
    row.images = p.images
    row.videos = p.videos
    row.audios = p.audios
    row.files = suppressStreamFiles ? [] : p.files
    if (st) row.subagentTasks = st
    if (tt) row.terminalStreams = tt
    if (s.aguiTurn) row.aguiTurn = s.aguiTurn
    cached.textLen = textLen
    cached.reasoningLen = reasoningLen
    if (sessionKey && row?.role === '_stream') {
      logStreamCompareAgUiInternals({
        sessionKey,
        runId: row.runId || s.runId || undefined,
        aguiTurn: s.aguiTurn,
        compactedParts: s.compactedParts,
        label: 'compacted+agui',
      })
    }
    return row
  }

  const p = isolateStreamProjection(turnStateForStreamDisplay(s), priorTurnStrip)
  const row = finalizeStreamRow(s, p, priorTurnStrip, liveTurnTokenStr, suppressStreamFiles, isSending)
  if (sessionKey && row?.role === '_stream') {
    logStreamCompareAgUiInternals({
      sessionKey,
      runId: row.runId || s.runId || undefined,
      aguiTurn: s.aguiTurn,
      compactedParts: s.compactedParts,
      label: 'compacted+agui',
    })
  }
  rowBuildCache.set(s, { structuralKey: sk, metaKey: mk, textLen, reasoningLen, row })
  return row
}
