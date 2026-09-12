/**
 * AG-UI event reducer → AgUiTurnState (+ compat projection to legacy segments).
 */
import type { AGUIEvent } from '@ag-ui/core'
import { EventType } from '@ag-ui/core'
import type { MessageSegment, CompactedStreamPart } from '../chat-types.js'
import {
  appendStreamBodyPiece,
  capStreamTailText,
  capStreamTurnState,
  mergeReasoningStreamPiece,
  STREAM_ASSISTANT_BODY_CAP,
  STREAM_REASONING_TEXT_CAP,
} from './stream-turn-engine.js'
import {
  maybeSlimToolOutputForUi,
  mergeStreamingToolCallArgStrings,
  syncToolStatusFromEnvelope,
} from '../../lib/chat-normalize.js'
import { parseStreamBlockWire, type ContentBlockKind } from './content-blocks.js'

/** Streaming tool-call JSON args — tail kept if model streams huge payloads. */
const STREAM_TOOL_ARGS_CAP = 262_144

/**
 * Extract a JSON string field from partial args JSON while the model is still
 * streaming. Unlike a closed-quote regex, this returns the in-progress value
 * before the closing ``"`` arrives — required for live write-file previews.
 *
 * Only matches keys at the **root object** depth so ``"path":`` inside
 * ``old_string`` / ``new_string`` / ``content`` bodies (common for replace)
 * cannot steal or blank the real path.
 */
function extractPartialJsonStringField(argsText: string, key: string): string {
  const text = String(argsText || '')
  if (!text) return ''
  const keyPat = `"${key}"`
  const keyPatLower = keyPat.toLowerCase()
  let depth = 0
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      if (depth === 1 && text.slice(i, i + keyPat.length).toLowerCase() === keyPatLower) {
        let j = i + keyPat.length
        while (j < text.length && /\s/.test(text[j]!)) j++
        if (text[j] !== ':') {
          inString = true
          continue
        }
        j++
        while (j < text.length && /\s/.test(text[j]!)) j++
        if (text[j] !== '"') return ''
        j++
        let out = ''
        while (j < text.length) {
          const c = text[j]!
          if (c === '\\') {
            const n = text[j + 1]
            if (n === undefined) break
            if (n === 'n') out += '\n'
            else if (n === 't') out += '\t'
            else if (n === 'r') out += '\r'
            else if (n === '"' || n === '\\' || n === '/') out += n
            else out += n
            j += 2
            continue
          }
          if (c === '"') break
          out += c
          j++
        }
        return out
      }
      inString = true
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') depth = Math.max(0, depth - 1)
    else if (ch === '[') depth++
    else if (ch === ']') depth = Math.max(0, depth - 1)
  }
  return ''
}

export type AgUiToolPhase = 'args' | 'running' | 'done'

export type AgUiMessage = {
  messageId: string
  role: 'assistant' | 'reasoning'
  content: string
  closed: boolean
}

export type AgUiToolCall = {
  toolCallId: string
  toolCallName: string
  argsText: string
  argsPreview: string
  phase: AgUiToolPhase
  result: string | null
  /** Wire status from TOOL_CALL_RESULT or envelope (e.g. pending_approval). */
  resultStatus?: string
  resultTruncated?: boolean
  resultContentBytes?: number
  /** Live write/replace preview — must survive syncAgUiCompatProjection. */
  _writeProgress?: Record<string, unknown>
  /** Preserved platform feedback when full output is slimmed. */
  platformUi?: Record<string, unknown>
  platformAction?: string
  platformItem?: Record<string, unknown>
  platformAgent?: Record<string, unknown>
  platformRole?: Record<string, unknown>
  platformOk?: boolean
  platformSettings?: Record<string, unknown>
  platformClientEffect?: string
}

export type AgUiStep = {
  stepName: string
  finished: boolean
}

type AgUiOrderBlockMeta = {
  seq?: number
  blockKind?: ContentBlockKind
  blockId?: string
}

/** Chronological slot order (reasoning / tool / text interleaving). */
export type AgUiOrderEntry =
  | ({ kind: 'reasoning'; messageId: string } & AgUiOrderBlockMeta)
  | ({ kind: 'text'; messageId: string } & AgUiOrderBlockMeta)
  | ({ kind: 'tool'; toolCallId: string } & AgUiOrderBlockMeta)

export type AgUiTurnState = {
  runId: string
  threadId: string
  messages: Map<string, AgUiMessage>
  toolCalls: Map<string, AgUiToolCall>
  /** Event arrival order for display + compat segments */
  order: AgUiOrderEntry[]
  steps: AgUiStep[]
  activity: string | null
  finished: boolean
  /** @deprecated compat — synced segments for legacy display during transition */
  compatSegments: MessageSegment[]
  /** @deprecated compat — tool entries for ToolCallList */
  compatTools: unknown[]
  /** Tool call IDs from sealed/compacted rounds - skip re-adding from MESSAGES_SNAPSHOT */
  sealedToolIds: Set<string>
  /** Message IDs from sealed/compacted rounds - skip re-adding from MESSAGES_SNAPSHOT */
  sealedMessageIds: Set<string>
  /**
   * 自上一条 TOOL_CALL_START 后是否收到过 TOOL_CALL_RESULT。
   * 无 blockId 的 wire 上，这是「新 START 属于新一轮而非同批并行」的证据：
   * 模型必须拿到全部旧结果才会发起新调用。
   */
  sawResultSinceLastToolStart?: boolean
}

const MIND_MAP_TAG_RE = /<session_mind_map[\s\S]*?<\/session_mind_map>/gi

export function emptyAgUiTurnState(runId = '', threadId = ''): AgUiTurnState {
  return {
    runId,
    threadId,
    messages: new Map(),
    toolCalls: new Map(),
    order: [],
    steps: [],
    activity: null,
    finished: false,
    compatSegments: [],
    compatTools: [],
    sealedToolIds: new Set(),
    sealedMessageIds: new Set(),
    sawResultSinceLastToolStart: false,
  }
}

/** Attach/resume: seed persisted assistant text so live tail deltas append visibly. */
export function seedAgUiTurnBaseline(state: AgUiTurnState, baselineText: string): AgUiTurnState {
  const text = String(baselineText || '').trim()
  if (!text) return state
  const messageId = '__resume_baseline__'
  const next = cloneAgUiTurnState(state)
  next.messages.set(messageId, { messageId, role: 'assistant', content: text, closed: false })
  if (!next.order.some((e) => e.kind === 'text' && e.messageId === messageId)) {
    next.order.push({ kind: 'text', messageId })
  }
  return syncAgUiCompatProjection(next)
}

export function cloneAgUiTurnState(s: AgUiTurnState): AgUiTurnState {
  return {
    runId: s.runId,
    threadId: s.threadId,
    messages: new Map([...s.messages.entries()].map(([k, v]) => [k, { ...v }])),
    toolCalls: new Map([...s.toolCalls.entries()].map(([k, v]) => [k, { ...v }])),
    order: s.order.map((e) => ({ ...e })),
    steps: s.steps.map((x) => ({ ...x })),
    activity: s.activity,
    finished: s.finished,
    compatSegments: (s.compatSegments || []).map((seg) => {
      if (seg.kind === 'tools') return { ...seg, ids: [...seg.ids] }
      return { ...seg }
    }),
    compatTools: [...(s.compatTools || [])],
    sealedToolIds: new Set(s.sealedToolIds || []),
    sealedMessageIds: new Set(s.sealedMessageIds || []),
    sawResultSinceLastToolStart: !!s.sawResultSinceLastToolStart,
  }
}

function stripMindMapLeak(text: string): string {
  return String(text || '').replace(MIND_MAP_TAG_RE, '')
}

/** Strip mind_map XML leak; trim only when collapsing to a stored segment (not per delta). */
function filterMindMapLeak(text: string): string {
  return stripMindMapLeak(text).trim()
}

function parseArgsPreview(argsText: string): string {
  const raw = String(argsText || '').trim()
  if (!raw) return ''
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    const keys = ['query', 'path', 'recipient', 'url', 'command', 'pattern', 'file_path']
    const parts: string[] = []
    for (const k of keys) {
      const v = obj[k]
      if (v != null && String(v).trim()) parts.push(`${k}=${String(v).slice(0, 80)}`)
    }
    if (parts.length) return parts.join(' · ')
    return ''
  } catch {
    return ''
  }
}

function parseBlockMetaFromAgUiEvent(event: Record<string, unknown>): AgUiOrderBlockMeta {
  const wire = parseStreamBlockWire(event)
  if (!wire) return {}
  return { seq: wire.seq, blockKind: wire.blockKind, blockId: wire.blockId }
}

function orderEntryKey(entry: AgUiOrderEntry): string {
  if (entry.kind === 'tool') return `tool:${entry.toolCallId}`
  return `${entry.kind}:${entry.messageId}`
}

/** Distinct tools block batches in wire order (blockId boundary). */
function countToolBatchBoundaries(order: AgUiOrderEntry[]): number {
  let count = 0
  let lastBlockId: string | undefined
  for (const entry of order) {
    if (entry.kind !== 'tool') {
      lastBlockId = undefined
      continue
    }
    const bid = entry.blockId || `anon:${entry.toolCallId}`
    if (bid !== lastBlockId) {
      count += 1
      lastBlockId = bid
    }
  }
  return count
}

/** MESSAGES_SNAPSHOT must not collapse live tool batches (snapshot often merges tool slots). */
function mergeSnapshotOrderPreservingLive(
  live: AgUiOrderEntry[],
  snap: AgUiOrderEntry[],
): AgUiOrderEntry[] {
  if (!snap.length) return live
  if (!live.length) return sortOrderEntries(snap)

  const liveBatches = countToolBatchBoundaries(live)
  const snapBatches = countToolBatchBoundaries(snap)
  if (snapBatches < liveBatches) {
    return live
  }

  const liveByKey = new Map(live.map((e) => [orderEntryKey(e), e]))
  const merged: AgUiOrderEntry[] = snap.map((e) => {
    const prev = liveByKey.get(orderEntryKey(e))
    return prev ? { ...prev, ...e, seq: e.seq ?? prev.seq } : e
  })
  for (const e of live) {
    if (!merged.some((m) => orderEntryKey(m) === orderEntryKey(e))) {
      merged.push(e)
    }
  }
  return sortOrderEntries(merged)
}

/**
 * Sort by wire seq only when **every** entry has seq.
 * Partial seq (common while streaming) must keep arrival order — otherwise a late
 * seq on an open reasoning slot jumps「思考」above already-rendered tools/body.
 */
function sortOrderEntries(order: AgUiOrderEntry[]): AgUiOrderEntry[] {
  if (!order.length || !order.every((e) => e.seq != null)) return order
  return [...order]
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const sa = a.e.seq
      const sb = b.e.seq
      if (sa != null && sb != null && sa !== sb) return sa - sb
      return a.i - b.i
    })
    .map((x) => x.e)
}

function insertOrderEntry(state: AgUiTurnState, entry: AgUiOrderEntry): void {
  const key = orderEntryKey(entry)
  const idx = state.order.findIndex((e) => orderEntryKey(e) === key)
  if (idx >= 0) {
    const prev = state.order[idx]
    state.order[idx] = {
      ...prev,
      ...(entry.seq != null ? { seq: entry.seq } : {}),
      ...(entry.blockKind ? { blockKind: entry.blockKind } : {}),
      ...(entry.blockId ? { blockId: entry.blockId } : {}),
    }
    // 已有槽位只补 meta，禁止因晚到的 seq 重排——否则「思考」会从工具下方跳到上方。
    return
  }
  state.order.push(entry)
  state.order = sortOrderEntries(state.order)
}

/** @deprecated use insertOrderEntry — kept as alias for snapshot helpers */
function pushOrder(state: AgUiTurnState, entry: AgUiOrderEntry): void {
  insertOrderEntry(state, entry)
}

type AgUiSnapshotMessage = {
  id?: string
  role?: string
  content?: string
  toolCallId?: string
  tool_call_id?: string
  toolCalls?: unknown[]
  tool_calls?: unknown[]
  seq?: number
  blockKind?: string
  block_kind?: string
}

function blockMetaFromSnapshotMessage(msg: AgUiSnapshotMessage): AgUiOrderBlockMeta {
  const seqRaw = msg.seq
  const seq = typeof seqRaw === 'number' && Number.isFinite(seqRaw) ? seqRaw : undefined
  const blockKindRaw = String(msg.blockKind || msg.block_kind || '').trim()
  const blockKind =
    blockKindRaw === 'plan_text' ||
    blockKindRaw === 'body_text' ||
    blockKindRaw === 'reasoning' ||
    blockKindRaw === 'tools'
      ? (blockKindRaw as ContentBlockKind)
      : undefined
  const messageId = String(msg.id || '').trim()
  return {
    seq,
    blockKind,
    blockId: messageId || undefined,
  }
}

function isAgUiToolResultMessage(msg: AgUiSnapshotMessage | null | undefined): boolean {
  const role = String(msg?.role || '').trim().toLowerCase()
  return role === 'tool' || role === 'toolresult' || role === 'tool_result'
}

function resolveToolCallIdFromSnapshotMessage(msg: AgUiSnapshotMessage): string {
  const fromField = String(msg.toolCallId || msg.tool_call_id || '').trim()
  if (fromField) return fromField
  const id = String(msg.id || '').trim()
  if (id.endsWith('-result')) return id.slice(0, -'-result'.length)
  return ''
}

/** ``role: tool`` rows carry ``content`` for TOOL_CALL_RESULT — never assistant body text. */
function applyToolResultFromSnapshotMessage(state: AgUiTurnState, msg: AgUiSnapshotMessage): void {
  const toolCallId = resolveToolCallIdFromSnapshotMessage(msg)
  if (!toolCallId) return
  const content = String(msg.content || '')
  let tc = state.toolCalls.get(toolCallId)
  if (!tc) {
    tc = {
      toolCallId,
      toolCallName: 'tool',
      argsText: '',
      argsPreview: '',
      phase: 'done',
      result: null,
    }
    state.toolCalls.set(toolCallId, tc)
    pushOrder(state, { kind: 'tool', toolCallId })
  }
  tc.result = content
  tc.phase = 'done'
}

/** Rebuild chronological order from terminal MESSAGES_SNAPSHOT (block ledger authority). */
function orderFromMessagesSnapshot(msgs: AgUiSnapshotMessage[]): AgUiOrderEntry[] {
  const order: AgUiOrderEntry[] = []
  for (const msg of msgs) {
    if (!msg || typeof msg !== 'object') continue
    const messageId = String(msg.id || '').trim()
    if (!messageId) continue
    const role = String(msg.role || '').trim()
    if (isAgUiToolResultMessage(msg)) continue
    const blockMeta = blockMetaFromSnapshotMessage(msg)
    const toolCalls = msg.toolCalls || msg.tool_calls
    if (Array.isArray(toolCalls) && toolCalls.length) {
      for (const tc of toolCalls) {
        const o = tc as { id?: string; tool_call_id?: string }
        const toolCallId = String(o.id || o.tool_call_id || '').trim()
        if (toolCallId) order.push({ kind: 'tool', toolCallId, ...blockMeta })
      }
      continue
    }
    const content = String(msg.content || '').trim()
    if (!content) continue
    if (role === 'reasoning') order.push({ kind: 'reasoning', messageId, ...blockMeta })
    else if (role === 'assistant') order.push({ kind: 'text', messageId, ...blockMeta })
  }
  return sortOrderEntries(order)
}

function clearActivityOnContent(state: AgUiTurnState): void {
  state.activity = null
}

function upsertTextMessage(state: AgUiTurnState, messageId: string, role: 'assistant' | 'reasoning'): AgUiMessage {
  let msg = state.messages.get(messageId)
  if (!msg) {
    msg = { messageId, role, content: '', closed: false }
    state.messages.set(messageId, msg)
  }
  return msg
}

function toolEntryFromAgUi(tc: AgUiToolCall): Record<string, unknown> {
  const resultText = tc.result != null ? String(tc.result) : null
  const status = tc.resultStatus || (tc.phase === 'done' ? 'ok' : 'running')
  const entry: Record<string, unknown> = {
    id: tc.toolCallId,
    tool_call_id: tc.toolCallId,
    name: tc.toolCallName,
    type: 'tool_call',
    status,
    function: {
      name: tc.toolCallName,
      arguments: tc.argsText || '{}',
    },
    ...(resultText != null ? { content: resultText, output: resultText } : {}),
    ...(tc.resultTruncated
      ? {
          truncated: true,
          output_truncated: true,
          ...(tc.resultContentBytes != null
            ? { content_bytes: tc.resultContentBytes, output_bytes: tc.resultContentBytes }
            : {}),
        }
      : {}),
    _aguiArgsPreview: tc.argsPreview,
    _aguiPhase: tc.phase,
    _aguiTracked: true,
    ...(tc._writeProgress ? { _writeProgress: { ...tc._writeProgress } } : {}),
    ...(tc.platformUi ? { platform_ui: { ...tc.platformUi } } : {}),
    ...(tc.platformAction ? { platform_action: tc.platformAction } : {}),
    ...(tc.platformItem ? { platform_item: { ...tc.platformItem } } : {}),
    ...(tc.platformAgent ? { platform_agent: { ...tc.platformAgent } } : {}),
    ...(tc.platformRole ? { platform_role: { ...tc.platformRole } } : {}),
    ...(tc.platformSettings ? { platform_settings: { ...tc.platformSettings } } : {}),
    ...(tc.platformClientEffect ? { platform_client_effect: tc.platformClientEffect } : {}),
    ...(tc.platformOk ? { platform_ok: true } : {}),
  }
  syncToolStatusFromEnvelope(entry)
  return entry
}

type CompatSegmentFilter = {
  sealedToolIds?: Set<string>
  sealedMessageIds?: Set<string>
  /** Keep open reasoning slots so tool batches do not merge across in-flight thinking. */
  includeOpenReasoningSlots?: boolean
}

function projectCompatSegmentsFromOrder(
  state: AgUiTurnState,
  filter?: CompatSegmentFilter,
): MessageSegment[] {
  const segments: MessageSegment[] = []
  let fallbackSeq = 0
  let seenTools = false
  const sealedTools = filter?.sealedToolIds
  const sealedMessages = filter?.sealedMessageIds
  const includeOpenReasoningSlots =
    filter?.includeOpenReasoningSlots ?? (!sealedTools && !sealedMessages)

  const nextSegSeq = (entry: AgUiOrderEntry): number => {
    if (entry.seq != null) {
      fallbackSeq = Math.max(fallbackSeq, entry.seq)
      return entry.seq
    }
    fallbackSeq += 1
    return fallbackSeq
  }

  for (let oi = 0; oi < state.order.length; oi++) {
    const entry = state.order[oi]
    if (entry.kind === 'reasoning') {
      const msg = state.messages.get(entry.messageId)
      if (!msg) continue
      if (sealedMessages && !sealedMessages.has(entry.messageId)) continue
      const text = filterMindMapLeak(msg.content)
      if (!text) {
        if (includeOpenReasoningSlots && !msg.closed) {
          segments.push({
            kind: 'reasoning',
            text: '',
            seq: nextSegSeq(entry),
            id: entry.blockId || entry.messageId,
            blockKind: entry.blockKind || 'reasoning',
          })
        }
        continue
      }
      segments.push({
        kind: 'reasoning',
        text,
        seq: nextSegSeq(entry),
        id: entry.blockId || entry.messageId,
        blockKind: entry.blockKind || 'reasoning',
      })
    } else if (entry.kind === 'text') {
      const msg = state.messages.get(entry.messageId)
      if (!msg || !msg.closed) continue
      if (sealedMessages && !sealedMessages.has(entry.messageId)) continue
      const text = String(msg.content || '').trim()
      if (!text) continue
      const blockKind =
        entry.blockKind || (seenTools ? 'body_text' : 'plan_text')
      segments.push({
        kind: 'text',
        text,
        seq: nextSegSeq(entry),
        id: entry.blockId || entry.messageId,
        blockKind,
      })
    } else if (entry.kind === 'tool') {
      if (sealedTools && !sealedTools.has(entry.toolCallId)) continue
      seenTools = true
      const tc = state.toolCalls.get(entry.toolCallId)
      if (!tc) continue
      const prevOrder = oi > 0 ? state.order[oi - 1] : null
      const prevSeg = segments[segments.length - 1]
      const sameToolsBlock =
        prevOrder?.kind === 'tool' &&
        prevSeg?.kind === 'tools' &&
        Array.isArray(prevSeg.ids) &&
        !prevSeg.ids.includes(entry.toolCallId) &&
        (entry.blockId && prevOrder.blockId
          ? entry.blockId === prevOrder.blockId
          : !entry.blockId && !prevOrder.blockId)
      if (sameToolsBlock) {
        prevSeg.ids.push(entry.toolCallId)
        continue
      }
      segments.push({
        kind: 'tools',
        ids: [entry.toolCallId],
        seq: nextSegSeq(entry),
        id: entry.blockId || `tools-${entry.toolCallId}`,
        blockKind: entry.blockKind || 'tools',
      })
    }
  }
  return segments
}

/** Rebuild compat segments + tools from canonical AG-UI state (in-place; no clone). */
export function syncAgUiCompatProjection(state: AgUiTurnState): AgUiTurnState {
  state.compatSegments = projectCompatSegmentsFromOrder(state, {
    includeOpenReasoningSlots: true,
  })
  const tools: unknown[] = []
  for (const tc of state.toolCalls.values()) {
    const entry = toolEntryFromAgUi(tc)
    maybeSlimToolOutputForUi(entry)
    if (entry.output_truncated === true) {
      entry.content = entry.output
    }
    tools.push(entry)
  }
  state.compatTools = tools
  return state
}

function lastOpenReasoningEntry(
  order: AgUiOrderEntry[],
  messages: Map<string, AgUiMessage>,
): Extract<AgUiOrderEntry, { kind: 'reasoning' }> | null {
  for (let i = order.length - 1; i >= 0; i--) {
    const e = order[i]
    if (e.kind !== 'reasoning') continue
    const msg = messages.get(e.messageId)
    if (msg && !msg.closed) return e
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const e = order[i]
    if (e.kind === 'reasoning') return e
  }
  return null
}

function lastOpenAssistantTextEntry(
  state: AgUiTurnState,
): Extract<AgUiOrderEntry, { kind: 'text' }> | null {
  for (let i = state.order.length - 1; i >= 0; i--) {
    const e = state.order[i]
    if (e.kind !== 'text') continue
    const msg = state.messages.get(e.messageId)
    if (msg && !msg.closed && msg.role === 'assistant') return e
  }
  return null
}

/** Live tail source: only return content from truly open (non-closed) messages. */
function resolveLiveAssistantOpenText(state: AgUiTurnState): string {
  const entry = lastOpenAssistantTextEntry(state)
  return entry ? String(state.messages.get(entry.messageId)?.content || '') : ''
}

/** RUN_FINISHED / RUN_ERROR：把仍 open 的正文/思考标为 closed，进入 compatSegments。 */
export function sealOpenAgUiMessages(state: AgUiTurnState): void {
  for (const msg of state.messages.values()) {
    if (!msg.closed) msg.closed = true
  }
}

/**
 * compatSegments only include closed messages; inject open assistant text at wire seq
 * so tools-only + streaming body stays ordered (plan/tools/body without reasoning).
 */
export function timelineWithOpenAgUiAssistantText(
  closedTimeline: MessageSegment[],
  agui: AgUiTurnState,
): MessageSegment[] {
  const entry = lastOpenAssistantTextEntry(agui)
  if (!entry || entry.kind !== 'text') return closedTimeline
  const msg = agui.messages.get(entry.messageId)
  if (!msg || msg.closed || msg.role !== 'assistant') return closedTimeline
  const text = String(msg.content || '').trim()
  if (!text) return closedTimeline

  const segs = [...closedTimeline]
  const blockId = entry.blockId || entry.messageId
  const seenTools = segs.some((s) => s.kind === 'tools')
  const liveSeg: MessageSegment = {
    kind: 'text',
    text: msg.content,
    id: blockId,
    blockKind: entry.blockKind || (seenTools ? 'body_text' : 'plan_text'),
    ...(entry.seq != null ? { seq: entry.seq } : {}),
  }
  const idx = segs.findIndex((s) => s.kind === 'text' && s.id === blockId)
  if (idx >= 0) {
    segs[idx] = { ...segs[idx], ...liveSeg }
    return segs
  }
  return [...segs, liveSeg]
}

/**
 * compatSegments only include closed messages; inject the live reasoning segment so
 * stream bubbles can render in-progress thinking (not only after REASONING_MESSAGE_END).
 */
function reasoningSegmentIndex(
  segs: MessageSegment[],
  entry: Extract<AgUiOrderEntry, { kind: 'reasoning' }>,
): number {
  const ids = new Set(
    [entry.messageId, entry.blockId].map((x) => String(x || '').trim()).filter(Boolean),
  )
  if (!ids.size) return -1
  return segs.findIndex((s) => s.kind === 'reasoning' && !!s.id && ids.has(String(s.id)))
}

export function timelineWithOpenAgUiReasoning(
  closedTimeline: MessageSegment[],
  agui: AgUiTurnState,
): MessageSegment[] {
  const entry = lastOpenReasoningEntry(agui.order, agui.messages)
  if (!entry) return closedTimeline
  const msg = agui.messages.get(entry.messageId)
  if (!msg || msg.closed) return closedTimeline
  const text = filterMindMapLeak(String(msg.content || '')).trim()
  if (!text) return closedTimeline

  const segs = [...closedTimeline]
  const idx = reasoningSegmentIndex(segs, entry)
  const liveSeg: MessageSegment = {
    kind: 'reasoning',
    text,
    id: entry.blockId || entry.messageId,
    blockKind: entry.blockKind || 'reasoning',
    ...(entry.seq != null
      ? { seq: entry.seq }
      : idx >= 0 && segs[idx].seq != null
        ? { seq: segs[idx].seq }
        : {}),
  }
  if (idx >= 0) {
    segs[idx] = { ...segs[idx], ...liveSeg }
    return segs
  }
  // Fallback: prefer chronological append. Only splice mid-timeline when order
  // position is strictly after already-projected prior slots (never before tools
  // that already appear later in closedTimeline).
  const reasoningOrderIdx = agui.order.findIndex(
    (e) => e.kind === 'reasoning' && e.messageId === entry.messageId,
  )
  if (reasoningOrderIdx < 0) return [...segs, liveSeg]
  let insertAt = 0
  for (let oi = 0; oi < reasoningOrderIdx; oi++) {
    const orderEntry = agui.order[oi]
    if (orderEntry.kind === 'reasoning') {
      const prior = agui.messages.get(orderEntry.messageId)
      const segText = filterMindMapLeak(String(prior?.content || '')).trim()
      if (segText) insertAt += 1
    } else if (orderEntry.kind === 'text') {
      const prior = agui.messages.get(orderEntry.messageId)
      if (prior?.closed && String(prior.content || '').trim()) insertAt += 1
    } else if (orderEntry.kind === 'tool') {
      const prevOrder = oi > 0 ? agui.order[oi - 1] : null
      if (prevOrder?.kind !== 'tool') insertAt += 1
    }
  }
  // 若计算结果仍落在已有 tools/text 之前，说明 order 与 closed 投影短暂不一致——追加到末尾保到达序。
  const wouldJumpAboveRendered =
    insertAt < segs.length &&
    segs.slice(insertAt).some((s) => s.kind === 'tools' || (s.kind === 'text' && String(s.text || '').trim()))
  if (wouldJumpAboveRendered) {
    const hasTools = segs.some((s) => s.kind === 'tools')
    if (!hasTools) {
      const firstText = segs.findIndex(
        (s) => s.kind === 'text' && String(s.text || '').trim(),
      )
      if (firstText >= 0) {
        return [...segs.slice(0, firstText), liveSeg, ...segs.slice(firstText)]
      }
    }
    return [...segs, liveSeg]
  }
  segs.splice(Math.min(insertAt, segs.length), 0, liveSeg)
  return segs
}

export function applyAgUiEvent(state: AgUiTurnState, event: AGUIEvent): AgUiTurnState {
  const t = event.type

  if (t === EventType.RUN_STARTED) {
    state.runId = String((event as { runId?: string }).runId || state.runId)
    state.threadId = String((event as { threadId?: string }).threadId || state.threadId)
    return syncAgUiCompatProjection(state)
  }

  if (t === EventType.TEXT_MESSAGE_START) {
    const e = event as { messageId: string; role?: string }
    const role = e.role === 'reasoning' ? 'reasoning' : 'assistant'
    upsertTextMessage(state, e.messageId, role)
    insertOrderEntry(state, {
      kind: 'text',
      messageId: e.messageId,
      ...parseBlockMetaFromAgUiEvent(e as Record<string, unknown>),
    })
    clearActivityOnContent(state)
    return syncAgUiCompatProjection(state)
  }

  if (t === EventType.TEXT_MESSAGE_CONTENT) {
    const e = event as { messageId: string; delta: string }
    const msg = upsertTextMessage(state, e.messageId, 'assistant')
    msg.content = capStreamTailText(
      appendStreamBodyPiece(msg.content, String(e.delta || '')),
      STREAM_ASSISTANT_BODY_CAP,
    )
    // CONTENT may carry block meta; also recover order if START was dropped.
    const meta = parseBlockMetaFromAgUiEvent(e as Record<string, unknown>)
    insertOrderEntry(state, {
      kind: 'text',
      messageId: e.messageId,
      ...meta,
    })
    clearActivityOnContent(state)
    return syncAgUiCompatProjection(state)
  }

  if (t === EventType.TEXT_MESSAGE_END) {
    const e = event as { messageId: string }
    const msg = state.messages.get(e.messageId)
    if (msg) msg.closed = true
    return syncAgUiCompatProjection(state)
  }

  if (t === EventType.REASONING_START || t === EventType.REASONING_MESSAGE_START) {
    const e = event as { messageId: string }
    upsertTextMessage(state, e.messageId, 'reasoning')
    insertOrderEntry(state, {
      kind: 'reasoning',
      messageId: e.messageId,
      ...parseBlockMetaFromAgUiEvent(e as Record<string, unknown>),
    })
    clearActivityOnContent(state)
    return syncAgUiCompatProjection(state)
  }

  if (t === EventType.REASONING_MESSAGE_CONTENT) {
    const e = event as { messageId: string; delta: string }
    const msg = upsertTextMessage(state, e.messageId, 'reasoning')
    const piece = stripMindMapLeak(String(e.delta || ''))
    if (piece) {
      msg.content = capStreamTailText(
        mergeReasoningStreamPiece(msg.content, piece),
        STREAM_REASONING_TEXT_CAP,
      )
    }
    // START may arrive without block meta (model-bridge); CONTENT often carries seq later.
    const meta = parseBlockMetaFromAgUiEvent(e as Record<string, unknown>)
    if (meta.seq != null || meta.blockId || meta.blockKind) {
      insertOrderEntry(state, {
        kind: 'reasoning',
        messageId: e.messageId,
        ...meta,
      })
    }
    clearActivityOnContent(state)
    return syncAgUiCompatProjection(state)
  }

  if (t === EventType.REASONING_MESSAGE_END || t === EventType.REASONING_END) {
    const e = event as { messageId: string }
    const msg = state.messages.get(e.messageId)
    if (msg) msg.closed = true
    return syncAgUiCompatProjection(state)
  }

  if (t === EventType.TOOL_CALL_START) {
    const e = event as { toolCallId: string; toolCallName: string }
    // 新一轮工具开始 = 模型已收到全部旧工具结果。旧批中 phase 未 done 的
    // 工具只是 TOOL_CALL_RESULT 丢失/未匹配，强制收尾为 done，避免「调用中」
    // 悬挂在最新轮次上方（shouldReleaseAgUiBufferBeforeToolStart 未触发时的兜底）。
    // 仅在新工具批次（blockId 与现有工具批次不同）或「上次 START 后收到过 RESULT」
    // 时才收尾 —— 同批并行工具的连续 START 共享 blockId 且无中间 RESULT，不能互相收尾。
    {
      const incomingBlockId = String((event as { blockId?: string }).blockId || '').trim()
      let isNewRound = false
      if (incomingBlockId) {
        const prevToolBlockIds = new Set(
          state.order
            .filter((en) => en.kind === 'tool' && en.blockId)
            .map((en) => String(en.blockId || '')),
        )
        isNewRound = prevToolBlockIds.size > 0 && !prevToolBlockIds.has(incomingBlockId)
      } else if (state.sawResultSinceLastToolStart) {
        isNewRound = true
      }
      if (isNewRound) {
        for (const tc of state.toolCalls.values()) {
          if (tc.phase !== 'done') tc.phase = 'done'
        }
      }
    }
    state.sawResultSinceLastToolStart = false
    const prev = state.toolCalls.get(e.toolCallId)
    state.toolCalls.set(e.toolCallId, {
      toolCallId: e.toolCallId,
      toolCallName: e.toolCallName,
      argsText: prev?.argsText || '',
      argsPreview: prev?.argsPreview || '',
      phase: 'args',
      result: null,
      // Progress may arrive before START (custom write_file_progress); keep it.
      ...(prev?._writeProgress ? { _writeProgress: { ...prev._writeProgress } } : {}),
    })
    insertOrderEntry(state, {
      kind: 'tool',
      toolCallId: e.toolCallId,
      ...parseBlockMetaFromAgUiEvent(e as Record<string, unknown>),
    })
    clearActivityOnContent(state)
    return syncAgUiCompatProjection(state)
  }

  if (t === EventType.TOOL_CALL_ARGS) {
    const e = event as { toolCallId: string; delta: string }
    const tc = state.toolCalls.get(e.toolCallId)
    if (tc) {
      tc.argsText = capStreamTailText(
        mergeStreamingToolCallArgStrings(tc.argsText, String(e.delta || '')),
        STREAM_TOOL_ARGS_CAP,
      )
      tc.argsPreview = parseArgsPreview(tc.argsText)
      tc.phase = 'args'

      // For write tools, extract content from partial JSON args and update _writeProgress.content
      // so the diff modal can show real-time content streaming (including unfinished strings).
      const toolName = (tc.toolCallName || '').toLowerCase()
      if (['write', 'write_file', 'write_to_file', 'replace', 'str_replace', 'replace_in_file'].includes(toolName)) {
        let path = ''
        for (const key of ['path', 'target_file', 'file_path', 'filepath', 'filePath']) {
          path = extractPartialJsonStringField(tc.argsText, key)
          if (path.trim()) break
        }
        const content =
          extractPartialJsonStringField(tc.argsText, 'content') ||
          extractPartialJsonStringField(tc.argsText, 'contents') ||
          extractPartialJsonStringField(tc.argsText, 'text')
        const oldString = extractPartialJsonStringField(tc.argsText, 'old_string')
        const newString =
          extractPartialJsonStringField(tc.argsText, 'new_string') ||
          extractPartialJsonStringField(tc.argsText, 'new_str')

        const prevWp = tc._writeProgress || {}
        const nextContent = content || (typeof prevWp.content === 'string' ? prevWp.content : '') || ''
        const nextOld = oldString || (typeof prevWp.old_string === 'string' ? prevWp.old_string : '') || ''
        const nextNew = newString || (typeof prevWp.new_string === 'string' ? prevWp.new_string : '') || ''
        const isReplace = ['replace', 'str_replace', 'replace_in_file'].includes(toolName)
        const liveAdded = isReplace
          ? nextNew
            ? nextNew.split(/\r?\n/).length
            : 0
          : nextContent
            ? nextContent.split(/\r?\n/).length
            : 0
        const liveRemoved = isReplace
          ? nextOld
            ? nextOld.split(/\r?\n/).length
            : 0
          : 0
        tc._writeProgress = {
          ...prevWp,
          phase: 'args',
          path: path.trim() || prevWp.path || '',
          content: nextContent,
          old_string: nextOld,
          ...(nextNew ? { new_string: nextNew } : {}),
          content_len: Math.max(nextContent.length, nextNew.length),
          lines_added: liveAdded,
          lines_removed: liveRemoved,
        }
      }
    }
    return syncAgUiCompatProjection(state)
  }

  if (t === EventType.TOOL_CALL_END) {
    const e = event as { toolCallId: string }
    const tc = state.toolCalls.get(e.toolCallId)
    if (tc && tc.phase !== 'done') tc.phase = 'running'
    return syncAgUiCompatProjection(state)
  }

  if (t === EventType.TOOL_CALL_RESULT) {
    const e = event as {
      toolCallId: string
      content: string
      status?: string
      truncated?: boolean
      output_truncated?: boolean
      content_bytes?: number
      output_bytes?: number
    }
    const truncated = e.truncated === true || e.output_truncated === true
    const contentBytes = e.content_bytes ?? e.output_bytes
    const tc = state.toolCalls.get(e.toolCallId)
    if (tc) {
      state.sawResultSinceLastToolStart = true
    }
    if (tc) {
      tc.result = String(e.content || '')
      const wireStatus = String(e.status || '').trim().toLowerCase()
      if (wireStatus === 'pending_approval' || wireStatus === 'blocked' || wireStatus === 'error') {
        tc.resultStatus = wireStatus
      } else if (
        wireStatus === 'approved_waiting' ||
        wireStatus === 'awaiting_other_approval' ||
        wireStatus === 'approved' ||
        wireStatus === 'denied'
      ) {
        // Leave pending_approval UI; keep lightweight status for the tool card.
        tc.resultStatus = wireStatus
      } else {
        delete tc.resultStatus
      }
      tc.phase = 'done'
      if (truncated) {
        tc.resultTruncated = true
        if (contentBytes != null) tc.resultContentBytes = Number(contentBytes)
      } else {
        const slimProbe: Record<string, unknown> = {
          output: tc.result,
          name: tc.toolCallName,
          status: 'ok',
        }
        maybeSlimToolOutputForUi(slimProbe)
        if (slimProbe.platform_ui && typeof slimProbe.platform_ui === 'object') {
          tc.platformUi = slimProbe.platform_ui as Record<string, unknown>
          if (slimProbe.platform_action) tc.platformAction = String(slimProbe.platform_action)
          if (slimProbe.platform_item && typeof slimProbe.platform_item === 'object') {
            tc.platformItem = slimProbe.platform_item as Record<string, unknown>
          }
          if (slimProbe.platform_agent && typeof slimProbe.platform_agent === 'object') {
            tc.platformAgent = slimProbe.platform_agent as Record<string, unknown>
          }
          if (slimProbe.platform_role && typeof slimProbe.platform_role === 'object') {
            tc.platformRole = slimProbe.platform_role as Record<string, unknown>
          }
          if (slimProbe.platform_settings && typeof slimProbe.platform_settings === 'object') {
            tc.platformSettings = slimProbe.platform_settings as Record<string, unknown>
          }
          if (slimProbe.platform_client_effect) {
            tc.platformClientEffect = String(slimProbe.platform_client_effect)
          }
          tc.platformOk = true
        }
        if (slimProbe.output_truncated === true) {
          tc.result = String(slimProbe.output || '')
          tc.resultTruncated = true
          tc.resultContentBytes =
            Number(slimProbe.output_bytes ?? slimProbe.outputBytes ?? 0) || undefined
        }
      }
    }
    return syncAgUiCompatProjection(state)
  }

  if (t === EventType.STEP_STARTED) {
    const e = event as { stepName: string }
    state.steps.push({ stepName: e.stepName, finished: false })
    return state
  }

  if (t === EventType.STEP_FINISHED) {
    const e = event as { stepName: string }
    const step = [...state.steps].reverse().find((s) => s.stepName === e.stepName && !s.finished)
    if (step) step.finished = true
    return state
  }

  if (t === EventType.ACTIVITY_SNAPSHOT) {
    const e = event as { content?: Record<string, unknown> }
    const detail = String(e.content?.detail || e.content?.kind || '').trim()
    state.activity = detail || state.activity
    return state
  }

  if (t === EventType.CUSTOM) {
    const e = event as { name?: string; value?: unknown }
    if (e.name === 'write_file_progress' && e.value && typeof e.value === 'object') {
      const v = e.value as Record<string, unknown>
      const tid = String(v.tool_call_id || '').trim()
      if (tid) {
        let tc = state.toolCalls.get(tid)
        if (!tc) {
          tc = {
            toolCallId: tid,
            toolCallName: String(v.tool_name || 'write'),
            argsText: '',
            argsPreview: '',
            phase: 'args',
            result: null,
          }
          state.toolCalls.set(tid, tc)
          pushOrder(state, { kind: 'tool', toolCallId: tid })
        }
        const prevWp =
          tc._writeProgress && typeof tc._writeProgress === 'object' ? tc._writeProgress : {}
        let content = typeof prevWp.content === 'string' ? prevWp.content : ''
        let oldString = typeof prevWp.old_string === 'string' ? prevWp.old_string : ''
        let newString = typeof prevWp.new_string === 'string' ? prevWp.new_string : ''
        // Absolute snapshot wins over delta (large jumps / reconnect).
        if (typeof v.content === 'string') content = v.content
        else if (typeof v.content_delta === 'string' && v.content_delta) content += v.content_delta
        if (typeof v.old_string === 'string') oldString = v.old_string
        else if (typeof v.old_string_delta === 'string' && v.old_string_delta) {
          oldString += v.old_string_delta
        }
        if (typeof v.new_string === 'string') newString = v.new_string
        else if (typeof v.new_string_delta === 'string' && v.new_string_delta) {
          newString += v.new_string_delta
        }
        const toolNameLower = String(tc.toolCallName || v.tool_name || '').toLowerCase()
        const isReplaceTool = ['replace', 'str_replace', 'replace_in_file'].includes(toolNameLower)
        // replace: content channel carries new_string when server only sends content_delta
        if (isReplaceTool && !newString && content) newString = content
        const CAP = 512_000
        if (content.length > CAP) content = content.slice(0, CAP)
        if (oldString.length > CAP) oldString = oldString.slice(0, CAP)
        if (newString.length > CAP) newString = newString.slice(0, CAP)
        if (typeof v.tool_name === 'string' && v.tool_name.trim()) {
          tc.toolCallName = v.tool_name.trim()
        }
        const progressAdded = Number(v.lines_added)
        const progressRemoved = Number(v.lines_removed)
        const phase = String(v.phase || prevWp.phase || 'args').trim().toLowerCase()
        const phaseIsFinal = phase === 'writing' || phase === 'done' || phase === 'error'
        const hasNumericLines =
          (Number.isFinite(progressAdded) && progressAdded >= 0) ||
          (Number.isFinite(progressRemoved) && progressRemoved >= 0)
        const fallbackAdded = isReplaceTool
          ? newString
            ? newString.split(/\r?\n/).length
            : 0
          : content
            ? content.split(/\r?\n/).length
            : 0
        const fallbackRemoved = isReplaceTool
          ? oldString
            ? oldString.split(/\r?\n/).length
            : 0
          : 0
        // Latest event wins — do not fall back to prevWp.lines_* (stale across replaces).
        let nextAdded: number
        let nextRemoved: number
        if (phaseIsFinal && hasNumericLines) {
          nextAdded = Number.isFinite(progressAdded) ? progressAdded || 0 : 0
          nextRemoved = Number.isFinite(progressRemoved) ? progressRemoved || 0 : 0
        } else if (
          (Number.isFinite(progressAdded) && progressAdded > 0) ||
          (Number.isFinite(progressRemoved) && progressRemoved > 0)
        ) {
          nextAdded = Number.isFinite(progressAdded) ? progressAdded || 0 : 0
          nextRemoved = Number.isFinite(progressRemoved) ? progressRemoved || 0 : 0
        } else {
          nextAdded = fallbackAdded
          nextRemoved = fallbackRemoved
        }
        tc._writeProgress = {
          ...prevWp,
          path:
            typeof v.path === 'string' && v.path.trim()
              ? v.path
              : typeof prevWp.path === 'string'
                ? prevWp.path
                : '',
          tool_name: typeof v.tool_name === 'string' ? v.tool_name : prevWp.tool_name,
          phase: typeof v.phase === 'string' ? v.phase : prevWp.phase || 'args',
          lines_added: nextAdded,
          lines_removed: nextRemoved,
          ...(typeof v.bytes_total === 'number' && Number.isFinite(v.bytes_total)
            ? { bytes_total: v.bytes_total }
            : typeof prevWp.bytes_total === 'number'
              ? { bytes_total: prevWp.bytes_total }
              : {}),
          ...(typeof v.bytes_written === 'number' && Number.isFinite(v.bytes_written)
            ? { bytes_written: v.bytes_written }
            : typeof prevWp.bytes_written === 'number'
              ? { bytes_written: prevWp.bytes_written }
              : {}),
          ...(typeof v.message === 'string' && v.message
            ? { message: v.message }
            : typeof prevWp.message === 'string' && prevWp.message
              ? { message: prevWp.message }
              : {}),
          content,
          ...(oldString ? { old_string: oldString } : {}),
          ...(newString ? { new_string: newString } : {}),
          content_len:
            typeof v.content_len === 'number' && Number.isFinite(v.content_len)
              ? v.content_len
              : Math.max(
                  content.length,
                  newString.length,
                  typeof v.bytes_written === 'number' && Number.isFinite(v.bytes_written)
                    ? v.bytes_written
                    : 0,
                ),
        }
        return syncAgUiCompatProjection(state)
      }
    }
    return state
  }

  if (t === EventType.MESSAGES_SNAPSHOT) {
    const msgs = (event as { messages?: AgUiSnapshotMessage[] }).messages
    if (Array.isArray(msgs) && msgs.length) {
      for (const msg of msgs) {
        if (isAgUiToolResultMessage(msg)) {
          applyToolResultFromSnapshotMessage(state, msg)
          continue
        }
        const messageId = String(msg?.id || '').trim()
        const roleRaw = String(msg?.role || '').trim()
        if (roleRaw !== 'reasoning' && roleRaw !== 'assistant') continue
        const role = roleRaw === 'reasoning' ? 'reasoning' : 'assistant'
        const content = String(msg?.content || '')
        const toolCalls = msg?.toolCalls || msg?.tool_calls
        if (Array.isArray(toolCalls) && toolCalls.length) {
          for (const tc of toolCalls) {
            const o = tc as { id?: string; tool_call_id?: string; function?: { name?: string } }
            const toolCallId = String(o.id || o.tool_call_id || '').trim()
            if (!toolCallId) continue
            // Skip tool calls already sealed to compactedParts
            if (state.sealedToolIds.has(toolCallId)) continue
            if (!state.toolCalls.has(toolCallId)) {
              state.toolCalls.set(toolCallId, {
                toolCallId,
                toolCallName: String(o.function?.name || 'tool'),
                argsText: '',
                argsPreview: '',
                phase: 'done',
                result: null,
              })
            }
          }
          continue
        }
        if (!messageId || !content.trim()) continue
        // Skip messages already sealed to compactedParts
        if (state.sealedMessageIds.has(messageId)) continue
        const cap =
          role === 'reasoning'
            ? capStreamTailText(content, STREAM_REASONING_TEXT_CAP)
            : capStreamTailText(content, STREAM_ASSISTANT_BODY_CAP)
        const existing = state.messages.get(messageId)
        if (existing) {
          existing.content = cap
          existing.closed = true
          existing.role = role
        } else {
          state.messages.set(messageId, { messageId, role, content: cap, closed: true })
        }
      }
      // Rebuild order excluding sealed entries
      const snapOrder = orderFromMessagesSnapshot(msgs).filter((entry) => {
        if (entry.kind === 'tool') return !state.sealedToolIds.has(entry.toolCallId)
        return !state.sealedMessageIds.has(entry.messageId)
      })
      if (snapOrder.length) {
        state.order = mergeSnapshotOrderPreservingLive(state.order, snapOrder)
      }
    }
    return syncAgUiCompatProjection(state)
  }

  if (t === EventType.RUN_FINISHED) {
    state.finished = true
    state.activity = null
    // 兜底：run 结束时若仍有工具卡在 args/running phase（TOOL_CALL_RESULT 未到或丢失），
    // 强制收尾为 done，避免气泡里 path=xxx 摘要不消失、计时器持续跳秒。
    for (const tc of state.toolCalls.values()) {
      if (tc.phase !== 'done') tc.phase = 'done'
    }
    // wire 偶发丢 TEXT_MESSAGE_END：不封存则 body 只留在 openText，
    // final 落库只用 closed timeline 时会丢掉「工具后总结」。
    sealOpenAgUiMessages(state)
    return syncAgUiCompatProjection(state)
  }

  if (t === EventType.RUN_ERROR) {
    state.finished = true
    state.activity = String((event as { message?: string }).message || 'error')
    // 同上：错误终止时也要把未完成的工具置为 done，否则 UI 会一直认为它在运行。
    for (const tc of state.toolCalls.values()) {
      if (tc.phase !== 'done') tc.phase = 'done'
    }
    sealOpenAgUiMessages(state)
    return syncAgUiCompatProjection(state)
  }

  return state
}

export function replayAgUiEvents(events: AGUIEvent[], runId = '', threadId = ''): AgUiTurnState {
  let state = emptyAgUiTurnState(runId, threadId)
  for (const ev of events) {
    state = applyAgUiEvent(state, ev)
  }
  return state
}

/** Project AgUiTurnState → legacy StreamTurnState fields for compat display. */
export function projectAgUiToStreamTurnFields(state: AgUiTurnState): {
  timeline: MessageSegment[]
  tools: unknown[]
  openText: string
  reasoningPreview: string
  reasoningSegments: string[]
  systemActivity: string | null
} {
  const timeline = [...state.compatSegments]
  const reasoningSegments = timeline
    .filter((s) => s.kind === 'reasoning')
    .map((s) => (s.kind === 'reasoning' ? s.text : ''))
  const openText = resolveLiveAssistantOpenText(state)
  // 仅未闭合思考作为 live preview；已 END 的思考留在 timeline segments，
  // 勿再当 preview，否则多轮工具后会在最新工具下方复插首段 Thinking。
  const openEntry = lastOpenReasoningEntry(state.order, state.messages)
  const openReasoning = openEntry ? state.messages.get(openEntry.messageId) : undefined
  const reasoningPreview =
    openReasoning && !openReasoning.closed ? String(openReasoning.content || '') : ''
  return {
    timeline,
    tools: [...state.compatTools],
    openText,
    reasoningPreview,
    reasoningSegments,
    systemActivity: state.activity,
  }
}

export function syncStreamTurnFromAgUi(
  turn: import('./stream-turn-engine.js').StreamTurnState,
  agui: AgUiTurnState,
): import('./stream-turn-engine.js').StreamTurnState {
  const proj = projectAgUiToStreamTurnFields(agui)
  return capStreamTurnState({
    ...turn,
    timeline: timelineWithOpenAgUiReasoning(
      timelineWithOpenAgUiAssistantText(proj.timeline, agui),
      agui,
    ),
    tools: proj.tools,
    openText: proj.openText,
    blocks: {},
    blockOrder: [],
    reasoningPendingNewRound: false,
    systemActivity: proj.systemActivity,
  })
}

/**
 * 是否在处理新的 TOOL_CALL_START 前释放 AG-UI 缓冲。
 * 条件：已有至少一个 done 工具（上一轮已完成），且有可封存的 closed 消息或 done 工具；
 * 或新事件携带了与现有工具批次不同的 blockId（跨轮次批次必然分配新 block，
 * 中间夹了思考/正文的工具批次不能复用同一 open tools block）。
 */
export function shouldReleaseAgUiBufferBeforeToolStart(
  state: AgUiTurnState | null | undefined,
  event: AGUIEvent,
): boolean {
  if (!state || state.finished) return false
  if (event.type !== EventType.TOOL_CALL_START) return false
  // 新 blockId 批次：新一轮工具开始，旧批工具必然已全部执行完（模型收到全部
  // 结果才会发起新调用）。即使个别旧工具的 TOOL_CALL_RESULT 丢失导致 phase
  // 卡在 args/running，也应释放缓冲并由 drainAgUiCompletedRound 强制收尾，
  // 避免「调用中」工具一直悬挂在最新轮次上方。
  const incomingBlockId = String(
    (event as { blockId?: string }).blockId || '',
  ).trim()
  if (incomingBlockId) {
    const prevToolBlockIds = new Set(
      state.order
        .filter((e) => e.kind === 'tool' && e.blockId)
        .map((e) => String(e.blockId || '')),
    )
    if (prevToolBlockIds.size && !prevToolBlockIds.has(incomingBlockId)) {
      return true
    }
  }
  const hasDoneTools = [...state.toolCalls.values()].some((tc) => tc.phase === 'done')
  if (!hasDoneTools) return false
  const hasClosedMessages = [...state.messages.values()].some((m) => m.closed)
  return hasClosedMessages || hasDoneTools
}

/**
 * 新一轮工具开始前，强制收尾上一轮「幽灵调用中」工具。
 *
 * 调用时机保证（shouldReleaseAgUiBufferBeforeToolStart === true，即新的
 * TOOL_CALL_START 已到达）：模型必须收到全部旧工具结果才会生成新 tool_call，
 * 因此旧批中 phase 仍为 args/running 的工具只可能是 TOOL_CALL_RESULT 丢失 /
 * toolCallId 未匹配，实际早已执行完成。
 *
 * 不强制收尾的后果：这些工具永远不满足 drain 的 done 条件，一直留在
 * fresh 状态，以「调用中」光标悬挂在最新轮次上方。
 */
export function finalizeGhostRunningToolsBeforeNewRound(state: AgUiTurnState): boolean {
  let touched = false
  for (const tc of state.toolCalls.values()) {
    if (tc.phase !== 'done') {
      tc.phase = 'done'
      touched = true
    }
  }
  if (touched) {
    // 重建 compatTools，让封存切片里的条目 status 从 running → ok，
    // 否则封存后历史气泡仍会显示「调用中」光标。
    syncAgUiCompatProjection(state)
  }
  return touched
}

/**
 * 封存已完成轮次内容（closed 消息 + done 工具）到 CompactedStreamPart，
 * 然后从 aguiTurn 中移除以释放内存。保留 open/in-progress 项。
 * sealedToolIds/sealedMessageIds 记录已封存 ID，防止 MESSAGES_SNAPSHOT 回灌。
 */
export function drainAgUiCompletedRound(
  state: AgUiTurnState,
): {
  sealed: CompactedStreamPart | null
  releasedToolIds: string[]
  fresh: AgUiTurnState
} {
  // 收集已完成的消息和工具
  const sealedMessageIds: string[] = []
  const sealedToolIds: string[] = []

  for (const [id, msg] of state.messages) {
    if (msg.closed && !state.sealedMessageIds.has(id)) sealedMessageIds.push(id)
  }
  for (const [id, tc] of state.toolCalls) {
    if (tc.phase === 'done' && !state.sealedToolIds.has(id)) sealedToolIds.push(id)
  }

  if (!sealedMessageIds.length && !sealedToolIds.length) {
    return { sealed: null, releasedToolIds: [], fresh: state }
  }

  // 仅封存已 closed/done 的切片，避免把仍在 fresh 里流的思考/工具重复写入 compactedParts
  const segments = projectCompatSegmentsFromOrder(state, {
    sealedToolIds: new Set(sealedToolIds),
    sealedMessageIds: new Set(sealedMessageIds),
  })
  const tools = state.compatTools.filter((t) => {
    const o = t as Record<string, unknown>
    const id = String(o.id || o.tool_call_id || '').trim()
    return sealedToolIds.includes(id)
  })

  const sealedMessages = sealedMessageIds
    .map((id) => state.messages.get(id))
    .filter((m): m is AgUiMessage => !!m)

  const reasoningSegments = sealedMessages
    .filter((m) => m.role === 'reasoning')
    .map((m) => String(m.content || '').trim())
    .filter(Boolean)

  const textParts = sealedMessages
    .filter((m) => m.role === 'assistant')
    .map((m) => String(m.content || '').trim())
    .filter(Boolean)

  const sealed: CompactedStreamPart = {
    segments: segments.length ? segments : undefined,
    text: textParts.join('\n\n'),
    tools,
    reasoningSegments,
    reasoningPreview: reasoningSegments.length
      ? reasoningSegments[reasoningSegments.length - 1]
      : null,
    images: [],
    videos: [],
    audios: [],
    files: [],
  }

  // 构建 fresh state：移除已封存的消息和工具
  const fresh = cloneAgUiTurnState(state)

  for (const id of sealedMessageIds) {
    fresh.messages.delete(id)
    fresh.sealedMessageIds.add(id)
  }
  for (const id of sealedToolIds) {
    fresh.toolCalls.delete(id)
    fresh.sealedToolIds.add(id)
  }

  // 重建 order：仅保留仍存在的条目
  fresh.order = fresh.order.filter((entry) => {
    if (entry.kind === 'tool') return fresh.toolCalls.has(entry.toolCallId)
    return fresh.messages.has(entry.messageId)
  })

  // 重建 compat 投影
  syncAgUiCompatProjection(fresh)

  return { sealed, releasedToolIds: sealedToolIds, fresh }
}
