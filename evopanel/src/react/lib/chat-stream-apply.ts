/**
 * Stream 域：SSE / AG-UI 事件应用到流式状态。
 *
 * 从 ChatApp.tsx 抽离（零 React 依赖的纯函数层）。
 * 行为逐行保持一致，抽取目的仅为可测与可读。
 */
import type { DisplayRow, StreamState } from '../chat-types.js'
import { inferMediaAssetsFromToolEntries } from '../../lib/chat-normalize.js'
import { rowHasVisibleContent } from './display-row-content.js'
import type { SessionRuntime } from './session-runtime-store.js'
import {
  EMPTY_PRIOR_TURN_STRIP,
  rtAddStaleToolCallIds,
  rtAddStoppedRun,
} from './session-runtime-store.js'
import {
  collectToolCallIdsFromTurn,
  drainStreamTurnRoundBuffer,
  filterStaleToolEntries,
  finalizeStreamTurn,
  finalizedTurnToCompactedPart,
  reduceStreamTurn,
  shouldKeepStreamDeltaAfterStrip,
  shouldReleaseStreamBufferBeforeEvent,
  streamTurnHasVisibleContent,
  type StreamReleaseTrigger,
  type StreamTurnEvent,
  type StreamTurnState,
} from './stream-turn-engine.js'
import {
  applyAgUiEvent,
  cloneAgUiTurnState,
  emptyAgUiTurnState,
  syncStreamTurnFromAgUi,
} from './agui-turn-reducer.js'
import {
  commitPriorTurnStripTextFromStreamTurn,
  fixReasoningStreamText,
  sanitizeFinalizedTurnForPersist,
  stripLoosePriorBodyEcho,
  stripLoosePriorReasoningEcho,
  stripPriorTurnPollutants,
  stripPriorTurnReasoningFromStream,
  trimReasoningTextAgainstBody,
  type PriorTurnStripBundle,
} from './turn-text-isolation.js'
import { resolveVoiceSpeechBodyFromParts } from '../../lib/voice-reply-speech.js'
import { sfWarn } from './stream-final-debug.js'
import { EventType, type AGUIEvent } from '@ag-ui/core'

/** 工具产出媒体资源：每轮事件后同步到 turn.images/videos/audios */
function syncStreamMediaAssetsFromTools(S: StreamState) {
  const derived = inferMediaAssetsFromToolEntries(S.turn.tools || [])
  S.turn.images = derived.images
  if (derived.videos.length) S.turn.videos = derived.videos
  if (derived.audios.length) S.turn.audios = derived.audios
}

function applyStreamTurnEvent(S: StreamState, event: StreamTurnEvent): void {
  S.turn = reduceStreamTurn(S.turn, event)
}

function applyAgUiWireEvent(
  S: StreamState,
  event: AGUIEvent,
  priorStrip: PriorTurnStripBundle = EMPTY_PRIOR_TURN_STRIP,
): void {
  if (event.type === EventType.RUN_STARTED) {
    const incomingRunId = String((event as { runId?: string }).runId || '').trim()
    const threadId = String((event as { threadId?: string }).threadId || '').trim()
    const prevRunId = String(S.aguiTurn?.runId || S.runId || '').trim()
    if (incomingRunId && (!S.aguiTurn || (prevRunId && prevRunId !== incomingRunId))) {
      S.aguiTurn = emptyAgUiTurnState(incomingRunId, threadId)
      S.runId = incomingRunId
    }
  }
  if (!S.aguiTurn) {
    S.aguiTurn = emptyAgUiTurnState(String(S.runId || ''), '')
  }
  let wireEvent: AGUIEvent = event
  if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
    const delta = String((event as { delta?: string }).delta || '')
    if (delta) {
      const cleaned = stripLoosePriorBodyEcho(stripPriorTurnPollutants(delta, priorStrip), priorStrip.body)
      // 勿用 trim：独立 ``\n\n`` delta 是 markdown 段落分隔，trim 后会被误丢。
      if (!shouldKeepStreamDeltaAfterStrip(cleaned)) {
        sfWarn('agui delta stripped empty', {
          deltaPreview: delta.slice(0, 80),
          priorBodyLen: String(priorStrip.body || '').length,
        })
        return
      }
      if (cleaned !== delta) wireEvent = { ...event, delta: cleaned }
    }
  }
  if (event.type === EventType.REASONING_MESSAGE_CONTENT) {
    const delta = fixReasoningStreamText(String((event as { delta?: string }).delta || ''))
    if (delta) {
      const cleaned = stripLoosePriorReasoningEcho(
        stripPriorTurnReasoningFromStream(delta, priorStrip),
        priorStrip.reasoning,
      )
      if (!shouldKeepStreamDeltaAfterStrip(cleaned)) return
      if (cleaned !== delta) wireEvent = { ...event, delta: cleaned }
    }
  }
  S.aguiTurn = applyAgUiEvent(S.aguiTurn, wireEvent)
  const openBody = [...S.aguiTurn.messages.values()]
    .filter((m) => !m.closed && m.role === 'assistant')
    .map((m) => m.content)
    .join('')
  if (openBody.trim()) {
    const trimmed = cloneAgUiTurnState(S.aguiTurn)
    for (const msg of trimmed.messages.values()) {
      if (msg.closed || msg.role !== 'reasoning') continue
      msg.content = trimReasoningTextAgainstBody(msg.content, openBody)
    }
    S.aguiTurn = trimmed
  }
  S.turn = syncStreamTurnFromAgUi(S.turn, S.aguiTurn)
}

/** 去掉当前 user 轮内、尚未 final 的流式 partial assistant 行（多轮工具后已落库的中间段） */
function stripMidTurnPartialAssistantRows(rows: DisplayRow[]): DisplayRow[] {
  let lastUserIdx = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role === 'user') {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx < 0) return rows
  const head = rows.slice(0, lastUserIdx + 1)
  const tail = rows.slice(lastUserIdx + 1).filter((row) => {
    if (row.role !== 'assistant') return true
    if (row.durationStr || row.tokenStr) return true
    return row.incompleteStream === true && rowHasVisibleContent(row)
  })
  return [...head, ...tail]
}

/**
 * 下一条 SSE 处理前：封存已持久化段到 compactedParts，释放 turn 内存（仍合并进同一流式气泡）。
 */
function releaseStreamBufferIfNeeded(
  S: StreamState,
  rt: SessionRuntime,
  trigger: StreamReleaseTrigger,
  _applyRowsUpdate: (updater: (r: DisplayRow[]) => DisplayRow[]) => void,
  _runId?: string | null,
): boolean {
  if (S.aguiTurn) return false
  if (!shouldReleaseStreamBufferBeforeEvent(S.turn, trigger)) return false
  const { sealed, releasedToolIds, fresh } = drainStreamTurnRoundBuffer(S.turn)
  rtAddStaleToolCallIds(rt, releasedToolIds)
  if (streamTurnHasVisibleContent(sealed)) {
    const fin = finalizeStreamTurn(sealed, '')
    commitPriorTurnStripTextFromStreamTurn(rt, sealed)
    if (!S.compactedParts) S.compactedParts = []
    S.compactedParts.push(finalizedTurnToCompactedPart(fin))
  }
  S.turn = fresh
  return true
}

/** 用户停止 / aborted：把已收到的流式片段封存为一条 assistant 历史行 */
function buildPartialStreamAssistantRow(
  turn: StreamTurnState,
  runId?: string | null,
  priorStrip: PriorTurnStripBundle = EMPTY_PRIOR_TURN_STRIP,
): DisplayRow {
  const fin = sanitizeFinalizedTurnForPersist(finalizeStreamTurn(turn, ''), priorStrip)
  return {
    role: 'assistant',
    text: fin.text,
    segments: fin.segments,
    reasoningSegments: fin.reasoningSegments,
    reasoningPreview: fin.reasoningPreview,
    tools: [...fin.tools],
    images: [...fin.images],
    videos: [...fin.videos],
    audios: [...fin.audios],
    files: [...fin.files],
    timestamp: Date.now(),
    incompleteStream: true,
    ...(runId ? { runId: String(runId) } : {}),
  }
}

function sealStoppedStreamTurn(
  rt: SessionRuntime,
  turn: StreamTurnState,
  runId: string | null | undefined,
): void {
  rtAddStaleToolCallIds(rt, collectToolCallIdsFromTurn(turn))
  rtAddStoppedRun(rt, runId)
}

function filterStreamToolEntriesForRuntime(rt: SessionRuntime, entries: unknown[]): unknown[] {
  return filterStaleToolEntries(entries, rt.staleToolCallIds)
}

function priorStripForRuntime(rt: SessionRuntime): PriorTurnStripBundle {
  const s = rt.priorTurnStrip
  if (!s?.body && !s?.reasoning && !(s?.toolIds?.length)) return EMPTY_PRIOR_TURN_STRIP
  return { body: s.body, reasoning: s.reasoning, toolIds: s.toolIds || [] }
}

function stripBodyForRuntime(rt: SessionRuntime, text: string): string {
  return stripPriorTurnPollutants(String(text || ''), priorStripForRuntime(rt))
}

function buildVoiceSpeechBodyForRuntime(
  rt: SessionRuntime,
  parts: {
    hostedCaptureText?: string
    segments?: unknown[]
    text?: string
    canonicalOutText?: string
  },
): string {
  return stripBodyForRuntime(rt, resolveVoiceSpeechBodyFromParts(parts))
}

export {
  syncStreamMediaAssetsFromTools,
  applyStreamTurnEvent,
  applyAgUiWireEvent,
  stripMidTurnPartialAssistantRows,
  releaseStreamBufferIfNeeded,
  buildPartialStreamAssistantRow,
  sealStoppedStreamTurn,
  filterStreamToolEntriesForRuntime,
  priorStripForRuntime,
  stripBodyForRuntime,
  buildVoiceSpeechBodyForRuntime,
}
