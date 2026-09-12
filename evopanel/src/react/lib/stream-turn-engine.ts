/**
 * 当前轮 assistant 流式：单一真相源（事件 → 归约 → 投影）。
 * ChatApp 只追加 StreamTurnEvent，UI 只读 projectStreamTurn / finalizeStreamTurn。
 */
import type { MessageSegment } from '../chat-types.js'
import type { CompactedStreamPart } from '../chat-types.js'
import { mergeOrphanToolsIntoSegmentTimeline } from './message-row-timeline.js'
import {
  appendBlockText,
  // @ts-ignore
  appendBlockToolId,
  closeBlockInState,
  collectToolIdsFromBlockState,
  flushOpenTextIntoBlockState,
  hasBlockTimeline,
  turnHasToolsBlock,
  reasoningFromBlockState,
  registerToolEntriesOnBlockState,
  segmentsFromBlockState,
  dedupeToolsTimelineSegments,
  type ContentBlock,
  type StreamBlockWire,
} from './content-blocks.js'
import { isToolCallPreambleAssistantNoise } from '../../lib/assistant-display-noise.js'
import {
  flattenStreamDisplayText,
  insertOrphanToolsIntoSegments,
  normalizeAssistantSegmentTimelineOrder,
  upsertTool,
  stripThinkingTags,
  stripLegacyEmbeddedReasoningPrefix,
  unwrapAssistantContentJsonEnvelope,
  assistantBodiesLooselySame,
  streamTextSuffixAfterPrefix,
  isToolRunning,
} from '../../lib/chat-normalize.js'
import { splitToolIdsForExploring } from './exploring-activity-group.js'

export type StreamTextPhase = 'pre_tools' | 'post_tools'

export type StreamTurnEvent =
  | { type: 'text_piece'; piece: string; phase?: StreamTextPhase | null; block?: StreamBlockWire }
  | { type: 'reasoning_piece'; piece: string; block?: StreamBlockWire }
  | { type: 'block_close'; block: StreamBlockWire }
  | { type: 'tools'; entries: unknown[]; block?: StreamBlockWire }
  /** 仅 upsert 工具行，不新开 tools 段（tool 结果 / values 快照） */
  | { type: 'tools_update'; entries: unknown[] }
  | {
      type: 'media'
      images?: unknown[]
      videos?: unknown[]
      audios?: unknown[]
      files?: unknown[]
    }
  | {
      type: 'worker_file_progress'
      parentToolCallId: string
      entry: Record<string, unknown>
    }
  | {
      type: 'write_file_progress'
      toolCallId: string
      progress: {
        path?: string
        tool_name?: string
        phase?: string
        lines_added: number
        lines_removed: number
        bytes_total?: number
        bytes_written?: number
        message?: string
        content?: string
        old_string?: string
        new_string?: string
        content_delta?: string
        old_string_delta?: string
        new_string_delta?: string
        content_len?: number
      }
    }
  | { type: 'system_activity'; detail: string; kind?: string; toolName?: string; ts?: number }

/** 单个状态的开始/结束时间记录（用于展示每个阶段耗时） */
export interface PhaseRecord {
  detail: string
  kind: string
  startedAt: number
  endedAt: number | null
}

/** 已封存时间线 + 当前开写正文 + 工具表（与 LangGraph tool_call_id 对齐） */
export interface StreamTurnState {
  /** 已封存：text | tools | reasoning（按发生顺序） */
  timeline: MessageSegment[]
  /** block_id/seq 权威时间线（与 SSE 一致） */
  blocks: Record<string, ContentBlock>
  blockOrder: string[]
  /** 当前正在写的正文（工具前/工具后各一段；遇 tools 事件封存） */
  openText: string
  textPhase: StreamTextPhase
  tools: unknown[]
  reasoningPendingNewRound: boolean
  images: unknown[]
  videos: unknown[]
  audios: unknown[]
  files: unknown[]
  /** 系统阶段提示（模型装配 / 推理 / 工具执行），来自 SSE activity 事件 */
  systemActivity: string | null
  /** 当前系统阶段的 kind（model / tools / system / idle） */
  systemActivityKind?: string
  /** 当前系统阶段开始时间（ms epoch） */
  systemActivityStartedAt: number | null
  /** 每个状态的历史记录（含开始/结束时间） */
  phaseHistory: PhaseRecord[]
}

function coerceMessageSegmentTimeline(timeline: unknown): MessageSegment[] {
  return Array.isArray(timeline) ? timeline : []
}

export function emptyStreamTurn(): StreamTurnState {
  return {
    timeline: [],
    blocks: {},
    blockOrder: [],
    openText: '',
    textPhase: 'pre_tools',
    tools: [],
    reasoningPendingNewRound: false,
    images: [],
    videos: [],
    audios: [],
    files: [],
    systemActivity: null,
    systemActivityKind: 'idle',
    systemActivityStartedAt: null,
    phaseHistory: [],
  }
}

export function cloneStreamTurn(s: StreamTurnState): StreamTurnState {
  return {
    timeline: (s.timeline || []).map((seg) => {
      if (seg.kind === 'tools') {
        return {
          ...(seg.id ? { id: seg.id } : {}),
          ...(seg.seq != null ? { seq: seg.seq } : {}),
          ...(seg.blockKind ? { blockKind: seg.blockKind } : {}),
          kind: 'tools' as const,
          ids: [...seg.ids],
        }
      }
      if (seg.kind === 'reasoning') {
        return {
          ...(seg.id ? { id: seg.id } : {}),
          ...(seg.seq != null ? { seq: seg.seq } : {}),
          ...(seg.blockKind ? { blockKind: seg.blockKind } : {}),
          kind: 'reasoning' as const,
          text: seg.text,
        }
      }
      return {
        ...(seg.id ? { id: seg.id } : {}),
        ...(seg.seq != null ? { seq: seg.seq } : {}),
        ...(seg.blockKind ? { blockKind: seg.blockKind } : {}),
        kind: 'text' as const,
        text: seg.text,
      }
    }),
    blocks: Object.fromEntries(
      Object.entries(s.blocks || {}).map(([k, b]) => [
        k,
        { ...b, toolIds: b.toolIds ? [...b.toolIds] : undefined },
      ]),
    ),
    blockOrder: [...(s.blockOrder || [])],
    openText: s.openText,
    textPhase: s.textPhase,
    tools: (s.tools || []).map((t) => ({ ...(t as Record<string, unknown>) })),
    reasoningPendingNewRound: !!s.reasoningPendingNewRound,
    images: [...(s.images || [])],
    videos: [...(s.videos || [])],
    audios: [...(s.audios || [])],
    files: [...(s.files || [])],
    systemActivity: s.systemActivity ?? null,
    systemActivityKind: s.systemActivityKind ?? 'idle',
    systemActivityStartedAt: s.systemActivityStartedAt ?? null,
    phaseHistory: [...(s.phaseHistory || [])],
  }
}

function timelineHasTools(timeline: MessageSegment[]): boolean {
  return (timeline || []).some((s) => s.kind === 'tools')
}

/** 单调追加：只接受增量或前缀增长，拒绝变短（非 evf piece 流、累积全文去重用） */
export function appendTextMonotonic(prev: string, piece: string): string {
  const p = String(piece || '')
  if (!p) return String(prev || '')
  const t = String(prev || '')
  if (!t) return p
  if (t === p) return t
  // 累积重放：piece 以 prev 为前缀 → piece 是更新版
  if (p.startsWith(t)) return p
  // 纯增量：原样追加。不再做尾部重叠合并（连续相同字符如 1000 会被误吞成 10）。
  return t + p
}

/**
 * evf ``delta`` piece 模式：原样拼接，不做重叠合并（合并会误吞片段边界上的 \\n\\n）。
 */
export function appendStreamDeltaPiece(prev: string, piece: string): string {
  const p = String(piece ?? '')
  if (!p) return String(prev ?? '')
  const open = String(prev ?? '')
  if (!open) return p
  // 纯增量：原样追加。不再做 includes/endsWith 跳过（连续相同字符如 1000 会被误吞成 10）。
  return open + p
}

/** 正文增量：兼容 delta 与偶发 cumulative 重放，避免尾部重复拼接几字 */
export function appendStreamBodyPiece(prev: string, piece: string): string {
  const p = String(piece ?? '')
  if (!p) return String(prev ?? '')
  const open = String(prev ?? '')
  if (!open) return p
  if (p === open) return open
  // 累积重放：piece 以 open 为前缀 → piece 是更新版全文
  if (p.startsWith(open)) return p
  // 纯增量：原样追加。不再做 endsWith/includes 跳过（连续相同字符如 1000 会被误吞成 10）。
  return open + p
}

/** Live assistant body (openText + sealed text segments). Tail kept — aligned with terminal OUT_CAP scale. */
export const STREAM_ASSISTANT_BODY_CAP = 512_000

/** Live reasoning segments per round. */
export const STREAM_REASONING_TEXT_CAP = 131_072

const STREAM_TRUNC_HEAD = '…（内容过长，仅保留最近部分）\n\n'

/** Keep the tail of streaming text so long runs cannot grow memory without bound. */
export function capStreamTailText(text: string, max: number): string {
  const s = String(text ?? '')
  if (max <= 0 || s.length <= max) return s
  const headLen = STREAM_TRUNC_HEAD.length
  const keep = Math.max(0, max - headLen)
  if (keep <= 0) return STREAM_TRUNC_HEAD.slice(0, max)
  return STREAM_TRUNC_HEAD + s.slice(-keep)
}

function capTimelineSegments(
  timeline: MessageSegment[],
  bodyCap: number,
  reasoningCap: number,
): MessageSegment[] {
  return timeline.map((seg) => {
    if (seg.kind === 'text') {
      return { kind: 'text', text: capStreamTailText(seg.text, bodyCap) }
    }
    if (seg.kind === 'reasoning') {
      return { kind: 'reasoning', text: capStreamTailText(seg.text, reasoningCap) }
    }
    return seg
  })
}

export function capStreamTurnState(state: StreamTurnState): StreamTurnState {
  const blocks = { ...state.blocks }
  for (const [id, b] of Object.entries(blocks)) {
    if (b.kind === 'reasoning') {
      blocks[id] = { ...b, text: capStreamTailText(b.text || '', STREAM_REASONING_TEXT_CAP) }
    } else if (b.kind === 'plan_text' || b.kind === 'body_text') {
      blocks[id] = { ...b, text: capStreamTailText(b.text || '', STREAM_ASSISTANT_BODY_CAP) }
    }
  }
  return {
    ...state,
    openText: capStreamTailText(state.openText, STREAM_ASSISTANT_BODY_CAP),
    timeline: capTimelineSegments(state.timeline, STREAM_ASSISTANT_BODY_CAP, STREAM_REASONING_TEXT_CAP),
    blocks,
  }
}

/** CJK 流式 reasoning 分片可能在字符间插入空格，合并前先归一化 */
function normalizeReasoningStreamPiece(text: string): string {
  const s = String(text || '')
  if (!s) return ''
  return s.replace(
    /([\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])\s+(?=[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/g,
    '$1',
  )
}

/** 同轮 reasoning 增量：兼容 delta 与 cumulative 重放，避免「用户用户」类重复 */
export function mergeReasoningStreamPiece(last: string, incoming: string): string {
  const r = normalizeReasoningStreamPiece(incoming ?? '')
  if (!r) return String(last ?? '')
  const prev = normalizeReasoningStreamPiece(last ?? '')
  if (!prev) return r
  if (r === prev) return prev
  // 累积重放：incoming 以 prev 为前缀 → incoming 是更新版全文
  if (r.startsWith(prev)) return r
  if (prev.startsWith(r)) return prev
  // 纯增量：原样追加。不再做尾部重叠合并（连续相同字符如 1000 会被误吞成 10）。
  return prev + r
}

function mergeReasoningSameRound(last: string, incoming: string): string {
  return mergeReasoningStreamPiece(last, incoming)
}

// @ts-ignore
function findLastReasoningIndex(timeline: MessageSegment[]): number {
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i].kind === 'reasoning') return i
  }
  return -1
}

function sealOpenText(state: StreamTurnState): StreamTurnState {
  const raw = String(state.openText || '').trim()
  if (!raw) return { ...state, openText: '' }
  if (hasBlockTimeline(state.blockOrder)) {
    const flushed = flushOpenTextIntoBlockState(state)
    return {
      ...state,
      blocks: flushed.blocks,
      blockOrder: flushed.blockOrder,
      openText: flushed.openText,
    }
  }
  if (
    !timelineHasTools(state.timeline) &&
    isToolCallPreambleAssistantNoise(raw, state.tools)
  ) {
    return { ...state, openText: '' }
  }
  return {
    ...state,
    timeline: [...state.timeline, { kind: 'text', text: state.openText }],
    openText: '',
  }
}

/** Tools that may run many times per turn; never rewrite an older row's call id to the newest. */
const TOOL_CALL_ID_RECONCILE_EXEMPT = new Set([
  'terminal',
  'bash',
  'execute_command',
  'read_file',
  'read_files',
  'read_context_slice',
  'read_lints',
  'search_code_index',
  'search_content',
  'list_dir',
  'ls',
  'write',
  'write_file',
  'write_to_file',
  'replace',
  'replace_in_file',
  'str_replace',
  'delete',
  'delete_file',
  'worker',
])

function toolCallIdReconcileExempt(name: string): boolean {
  const n = String(name || '').trim().toLowerCase()
  if (n === 'process' || n.startsWith('process_')) return true
  return TOOL_CALL_ID_RECONCILE_EXEMPT.has(n)
}

function streamingToolRowHasTerminalSnapshot(t: Record<string, unknown>): boolean {
  if (t._terminalData) return true
  const ts = t._terminalStream as { phase?: string } | undefined
  const phase = String(ts?.phase || '').trim()
  return phase === 'success' || phase === 'failed'
}

function streamingToolRowHasOutput(t: Record<string, unknown>): boolean {
  if (streamingToolRowHasTerminalSnapshot(t)) return true
  const out = t.output
  if (out == null) return false
  if (typeof out === 'string') return out.trim().length > 0
  return true
}

function reconcileToolCallIds(timeline: MessageSegment[], tools: unknown[], entries: unknown[]): void {
  for (const r of entries) {
    const entry = r as Record<string, unknown>
    const name = String(entry.name || '').trim()
    const newId = String(entry.id || entry.tool_call_id || '').trim()
    if (!name || !newId) continue
    if (toolCallIdReconcileExempt(name)) continue
    const pendingSameName = tools.filter((t) => {
      const row = t as Record<string, unknown>
      const tn = String(row.name || '').trim()
      if (tn !== name) return false
      if (streamingToolRowHasOutput(row)) return false
      const st = String(row.status || '').toLowerCase()
      if (st !== 'running' && st !== 'pending' && st !== 'in_progress') return false
      const oid = String(row.id || row.tool_call_id || '')
      return !!oid && oid !== newId
    }) as Record<string, unknown>[]
    if (pendingSameName.length !== 1) continue
    const row = pendingSameName[0]
    const oldId = String(row.id || row.tool_call_id || '')
    if (!oldId) continue
    for (const seg of timeline) {
      if (seg.kind !== 'tools' || !seg.ids?.length) continue
      seg.ids = seg.ids.map((id) => (String(id) === oldId ? newId : String(id)))
    }
    row.id = newId
    row.tool_call_id = newId
  }
}

function collectToolIdsFromTimeline(timeline: MessageSegment[]): Set<string> {
  const out = new Set<string>()
  for (const s of timeline) {
    if (s.kind !== 'tools') continue
    for (const id of s.ids || []) {
      const t = String(id).trim()
      if (t) out.add(t)
    }
  }
  return out
}

function collectNewToolIds(tools: unknown[], entries: unknown[]): string[] {
  const seen = new Set<string>()
  for (const t of tools) {
    const o = t as Record<string, unknown>
    const id = String(o.id || o.tool_call_id || '').trim()
    if (id) seen.add(id)
  }
  const out: string[] = []
  for (const e of entries) {
    const o = e as Record<string, unknown>
    const id = String(o.id || o.tool_call_id || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

function appendToolSegment(timeline: MessageSegment[], newIds: string[], tools: unknown[]): MessageSegment[] {
  const alreadyInTimeline = collectToolIdsFromTimeline(timeline)
  const ids = Array.from(
    new Set(newIds.map((id) => String(id).trim()).filter(Boolean)),
  ).filter((id) => !alreadyInTimeline.has(id))
  if (!ids.length) return timeline
  const tl = [...timeline]
  const lastIdx = tl.length - 1
  const last = lastIdx >= 0 ? tl[lastIdx] : null
  if (last?.kind === 'tools') {
    const prev = splitToolIdsForExploring(last.ids, tools as unknown[], false)
    const next = splitToolIdsForExploring(ids, tools as unknown[], false)
    const prevFile = prev.standalone.length > 0
    const nextFile = next.standalone.length > 0
    const canMerge =
      (prevFile && nextFile) ||
      (!prevFile && !nextFile && (prev.exploring.length > 0 || next.exploring.length > 0))
    if (canMerge) {
      const lastIdSet = new Set(last.ids.map((id) => String(id).trim()).filter(Boolean))
      const toMerge = ids.filter((id) => !lastIdSet.has(id))
      if (!toMerge.length) return tl
      const merged = Array.from(new Set([...last.ids.map((id) => String(id).trim()), ...toMerge]))
      tl[lastIdx] = { kind: 'tools', ids: merged }
      return tl
    }
  }
  tl.push({ kind: 'tools', ids })
  return tl
}

function usesBlockAuthority(state: StreamTurnState, block?: StreamBlockWire): boolean {
  return !!block?.blockId || hasBlockTimeline(state.blockOrder)
}

function applyBlockClose(state: StreamTurnState, block: StreamBlockWire): StreamTurnState {
  const patched = closeBlockInState(
    { blocks: state.blocks, blockOrder: state.blockOrder },
    block,
  )
  return { ...state, blocks: patched.blocks, blockOrder: patched.blockOrder }
}

function shouldSealOpenTextBeforeNewTools(state: StreamTurnState): boolean {
  const raw = String(state.openText || '').trim()
  if (!raw) return false
  return true
}

function applyToolsUpdateEvent(state: StreamTurnState, entries: unknown[]): StreamTurnState {
  if (!entries.length) return state
  const useBlockPath = hasBlockTimeline(state.blockOrder)
  const tools = [...state.tools]
  if (useBlockPath) {
    reconcileToolCallIds([], tools, entries)
    for (const e of entries) {
      if (e) upsertTool(tools, e)
    }
    const blockPatch = registerToolEntriesOnBlockState(
      { blocks: state.blocks, blockOrder: state.blockOrder },
      entries,
    )
    const hasTools = turnHasToolsBlock(blockPatch.blocks, blockPatch.blockOrder)
    return {
      ...state,
      tools: [...tools],
      blocks: blockPatch.blocks,
      blockOrder: blockPatch.blockOrder,
      textPhase: hasTools ? 'post_tools' : state.textPhase,
    }
  }
  let timeline = [...state.timeline]
  reconcileToolCallIds(timeline, tools, entries)
  for (const e of entries) {
    if (e) upsertTool(tools, e)
  }
  const existingIds = collectToolIdsFromTimeline(timeline)
  const newIds = collectNewToolIds(tools, entries).filter((id) => !existingIds.has(id))
  if (newIds.length) {
    timeline = appendToolSegment(timeline, newIds, tools)
  }
  const hasTools = timelineHasTools(timeline)
  return {
    ...state,
    timeline,
    tools: [...tools],
    textPhase: hasTools ? 'post_tools' : state.textPhase,
  }
}

function applyToolsEvent(
  state: StreamTurnState,
  entries: unknown[],
  block?: StreamBlockWire,
): StreamTurnState {
  if (!entries.length) return state
  let timeline = [...state.timeline]
  let tools = [...state.tools]
  let blocks = state.blocks
  let blockOrder = state.blockOrder
  const useBlockPath = !!block?.blockId || hasBlockTimeline(state.blockOrder)
  /* New tool_call rows must not steal ids from a prior same-name row still running. */
  const existingIds = useBlockPath
    ? collectToolIdsFromBlockState(blocks, blockOrder)
    : collectToolIdsFromTimeline(timeline)
  const newIds = collectNewToolIds(state.tools, entries).filter((id) => !existingIds.has(id))
  /** values / enrich 重放已有 tool_call 时勿封存 post-tool 流式 openText */
  const hasToolsInTurn = useBlockPath
    ? turnHasToolsBlock(blocks, blockOrder)
    : timelineHasTools(timeline)
  if (hasToolsInTurn && newIds.length === 0) {
    return applyToolsUpdateEvent(state, entries)
  }
  const blockPatch = registerToolEntriesOnBlockState({ blocks, blockOrder }, entries, block)
  blocks = blockPatch.blocks
  blockOrder = blockPatch.blockOrder
  // Block path: if new tool ids were NOT registered into any tools block
  // (all existing tools blocks are closed, and no block wire was provided),
  // synthesize a new tools block at the end (highest seq) so the new batch
  // renders at the bottom instead of being orphan-inserted above sealed text.
  if (useBlockPath && newIds.length) {
    const registeredIds = collectToolIdsFromBlockState(blocks, blockOrder)
    const unregistered = newIds.filter((id) => !registeredIds.has(id))
    if (unregistered.length) {
      const maxSeq = blockOrder.reduce(
        (m, id) => Math.max(m, blocks[id]?.seq ?? 0),
        0,
      )
      const synthWire: StreamBlockWire = {
        blockId: `tools:synth:${maxSeq + 1}`,
        blockKind: 'tools',
        seq: maxSeq + 1,
      }
      const synthEntries = entries.filter((e) => {
        if (!e) return false
        const o = e as Record<string, unknown>
        const id = String(o.id ?? o.tool_call_id ?? '').trim()
        return unregistered.includes(id)
      })
      const synthPatch = registerToolEntriesOnBlockState(
        { blocks, blockOrder },
        synthEntries,
        synthWire,
      )
      blocks = synthPatch.blocks
      blockOrder = synthPatch.blockOrder
    }
  }
  for (const e of entries) {
    if (e) upsertTool(tools, e)
  }
  tools = [...tools]
  const next = useBlockPath
    ? { ...state, timeline, tools, openText: state.openText }
    : shouldSealOpenTextBeforeNewTools(state)
      ? sealOpenText({ ...state, timeline, tools, openText: state.openText })
      : { ...state, timeline, tools, openText: state.openText }
  timeline = next.timeline
  if (newIds.length && !useBlockPath) {
    const timelineIds = collectToolIdsFromTimeline(timeline)
    const freshIds = newIds.filter((id) => !timelineIds.has(id))
    if (freshIds.length) {
      timeline = appendToolSegment(timeline, freshIds, tools)
    }
  }
  return {
    ...next,
    timeline,
    tools,
    blocks,
    blockOrder,
    textPhase: 'post_tools',
    reasoningPendingNewRound: true,
  }
}

function sanitizeStreamBodyText(raw: string): string {
  return stripLegacyEmbeddedReasoningPrefix(
    stripThinkingTags(unwrapAssistantContentJsonEnvelope(String(raw || ''))),
  )
}

function lastToolsSegmentIndexInTimeline(timeline: MessageSegment[]): number {
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i].kind === 'tools') return i
  }
  return -1
}

function trimReasoningOverlappingOpenText(
  timeline: MessageSegment[],
  openText: string,
): MessageSegment[] {
  const safeTimeline = coerceMessageSegmentTimeline(timeline)
  const tail = sanitizeStreamBodyText(String(openText || '')).trim()
  if (!tail || tail.length < 20) return safeTimeline
  const lastTools = lastToolsSegmentIndexInTimeline(safeTimeline)
  const probe = tail.slice(0, Math.min(96, tail.length))
  return safeTimeline
    .map((seg, i) => {
      if (seg.kind !== 'reasoning') return seg
      // 工具后的思考与最终汇报常并行流式：投影阶段勿裁切，否则最新思考整块消失
      if (lastTools >= 0 && i > lastTools) return seg
      const rt = String(seg.text || '').trim()
      if (!rt) return seg
      const idx = rt.indexOf(probe)
      if (idx >= 0) {
        const kept = rt.slice(0, idx).trim()
        if (kept.length < 20) return null
        return { kind: 'reasoning' as const, text: kept }
      }
      if (tail.length > 80 && rt.includes(tail.slice(0, 80))) {
        const bodyStart = rt.indexOf(tail.slice(0, 80))
        if (bodyStart >= 0) {
          const kept = rt.slice(0, bodyStart).trim()
          if (kept.length < 20) return null
          return { kind: 'reasoning' as const, text: kept }
        }
      }
      return seg
    })
    .filter((s): s is MessageSegment => s != null)
}

/** 工具前已封存的正文（不含 openText） */
function preToolsTextPlain(timeline: MessageSegment[], firstToolsIdx: number): string {
  const end = firstToolsIdx < 0 ? timeline.length : firstToolsIdx
  return timeline
    .slice(0, end)
    .filter((s): s is Extract<MessageSegment, { kind: 'text' }> => s.kind === 'text')
    .map((s) => String(s.text || ''))
    .join('\n\n')
    .trim()
}

function firstToolsSegmentIndex(timeline: MessageSegment[]): number {
  for (let i = 0; i < timeline.length; i++) {
    if (timeline[i].kind === 'tools') return i
  }
  return -1
}

/** run_end / 累积全文已含工具前开场白时，不再保留重复的 pre-tool 段 */
function authRedundantWithPreTool(prePlain: string, auth: string): boolean {
  const pre = String(prePlain || '').trim()
  const a = String(auth || '').trim()
  if (!pre || !a) return false
  if (a.startsWith(pre)) return true
  if (assistantBodiesLooselySame(pre, a)) return true
  const suffix = streamTextSuffixAfterPrefix(pre, a)
  return suffix !== null && suffix.length > 0 && suffix.length < a.length
}

function applyTextPiece(
  state: StreamTurnState,
  piece: string,
  phase?: StreamTextPhase | null,
  block?: StreamBlockWire,
): StreamTurnState {
  const raw = String(piece ?? '')
  if (!raw) return state
  let textPhase = state.textPhase
  const hasToolsInTurn = hasBlockTimeline(state.blockOrder)
    ? turnHasToolsBlock(state.blocks, state.blockOrder)
    : timelineHasTools(state.timeline)
  if (phase === 'post_tools') textPhase = 'post_tools'
  else if (phase === 'pre_tools' && !hasToolsInTurn) textPhase = 'pre_tools'
  else if (hasToolsInTurn) textPhase = 'post_tools'

  const openText = appendStreamBodyPiece(state.openText, raw)
  let blocks = state.blocks
  let blockOrder = state.blockOrder
  if (block?.blockId) {
    const patched = appendBlockText({ blocks, blockOrder }, block, raw)
    blocks = patched.blocks
    blockOrder = patched.blockOrder
  }
  return { ...state, openText, textPhase, blocks, blockOrder }
}

function findLastReasoningIndexBeforeTools(timeline: MessageSegment[]): number {
  const toolsIdx = firstToolsSegmentIndex(timeline)
  const end = toolsIdx < 0 ? timeline.length : toolsIdx
  for (let i = end - 1; i >= 0; i--) {
    if (timeline[i].kind === 'reasoning') return i
  }
  return -1
}

function findLastReasoningIndexAfterTools(timeline: MessageSegment[]): number {
  const toolsIdx = lastToolsSegmentIndex(timeline)
  if (toolsIdx < 0) return -1
  for (let i = timeline.length - 1; i > toolsIdx; i--) {
    if (timeline[i].kind === 'reasoning') return i
  }
  return -1
}

function applyReasoningPiece(
  state: StreamTurnState,
  piece: string,
  block?: StreamBlockWire,
): StreamTurnState {
  const r = String(piece || '')
  if (!r) return state

  let blocks = state.blocks
  let blockOrder = state.blockOrder
  if (block?.blockId) {
    const patched = appendBlockText({ blocks, blockOrder }, block, r)
    blocks = patched.blocks
    blockOrder = patched.blockOrder
  }

  if (usesBlockAuthority(state, block)) {
    return {
      ...state,
      blocks,
      blockOrder,
      reasoningPendingNewRound: false,
    }
  }

  const timeline = [...state.timeline]
  const hasToolsSeg = firstToolsSegmentIndex(timeline) >= 0

  if (hasToolsSeg) {
    const postIdx = findLastReasoningIndexAfterTools(timeline)
    const preIdx = findLastReasoningIndexBeforeTools(timeline)
    if (postIdx >= 0 && timeline[postIdx].kind === 'reasoning') {
      const last = String(timeline[postIdx].text || '')
      timeline[postIdx] = { kind: 'reasoning', text: mergeReasoningSameRound(last, r) }
    } else if (preIdx < 0) {
      // 工具已先到达且尚无任何思考：按到达序追加到末尾（不再插到首个 tools 之前，
      // 否则用户会看到思考突然跳到已输出工具上方）。
      timeline.push({ kind: 'reasoning', text: r })
    } else {
      // Had pre-tool reasoning already → this is a new post-tool round.
      timeline.push({ kind: 'reasoning', text: r })
    }
    return {
      ...state,
      timeline,
      blocks,
      blockOrder,
      reasoningPendingNewRound: false,
    }
  }

  const preIdx = findLastReasoningIndexBeforeTools(timeline)
  if (preIdx < 0) {
    timeline.push({ kind: 'reasoning', text: r })
  } else if (timeline[preIdx].kind === 'reasoning') {
    const last = String(timeline[preIdx].text || '')
    timeline[preIdx] = { kind: 'reasoning', text: mergeReasoningSameRound(last, r) }
  }
  return {
    ...state,
    timeline,
    blocks,
    blockOrder,
    reasoningPendingNewRound: false,
  }
}

function applyWorkerFileProgressEvent(
  state: StreamTurnState,
  parentToolCallId: string,
  entry: Record<string, unknown>,
): StreamTurnState {
  const parentId = String(parentToolCallId || '').trim()
  if (!parentId) return state
  const index = Number(entry.index)
  if (!Number.isFinite(index)) return state
  const slimEntry = slimWorkerFileProgressEntry(entry)
  const tools = state.tools.map((raw) => {
    const row = raw as Record<string, unknown>
    const id = String(row.id ?? row.tool_call_id ?? '').trim()
    if (id !== parentId) return raw
    const prev =
      row._workerFileProgress && typeof row._workerFileProgress === 'object'
        ? (row._workerFileProgress as Record<string, unknown>)
        : {}
    return {
      ...row,
      _workerFileProgress: { ...prev, [String(index)]: slimEntry },
    }
  })
  return { ...state, tools: [...tools] }
}

/** Soft cap for streamed write bodies held in turn state (UI preview). */
const WRITE_STREAM_CONTENT_CAP = 512_000

function applyWriteFileProgressEvent(
  state: StreamTurnState,
  toolCallId: string,
  progress: {
    path?: string
    tool_name?: string
    phase?: 'args' | 'writing' | 'done' | 'error' | string
    lines_added: number
    lines_removed: number
    bytes_total?: number
    bytes_written?: number
    message?: string
    content?: string
    old_string?: string
    new_string?: string
    content_delta?: string
    old_string_delta?: string
    new_string_delta?: string
    content_len?: number
  },
): StreamTurnState {
  const id = String(toolCallId || '').trim()
  if (!id) return state
  const tools = state.tools.map((raw) => {
    const row = raw as Record<string, unknown>
    const rowId = String(row.id ?? '').trim()
    const rowTc = String(row.tool_call_id ?? '').trim()
    // Prefer tool_call_id match (progress wire uses call_*), then id — never only
    // `id ?? tool_call_id` which misses when id(msg_*) ≠ tool_call_id(call_*).
    if (!(rowTc === id || rowId === id)) return raw
    const prevWp =
      row._writeProgress && typeof row._writeProgress === 'object'
        ? (row._writeProgress as Record<string, unknown>)
        : {}
    let content = typeof prevWp.content === 'string' ? prevWp.content : ''
    let oldString = typeof prevWp.old_string === 'string' ? prevWp.old_string : ''
    let newString = typeof prevWp.new_string === 'string' ? prevWp.new_string : ''
    const toolNameLower = String(progress.tool_name || prevWp.tool_name || '').toLowerCase()
    // Absolute snapshot wins over delta (reconnect / large jump).
    if (typeof progress.content === 'string') {
      content = progress.content
    } else if (typeof progress.content_delta === 'string' && progress.content_delta) {
      content += progress.content_delta
    }
    if (typeof progress.old_string === 'string') {
      oldString = progress.old_string
    } else if (typeof progress.old_string_delta === 'string' && progress.old_string_delta) {
      oldString += progress.old_string_delta
    }
    if (typeof progress.new_string === 'string') {
      newString = progress.new_string
    } else if (typeof progress.new_string_delta === 'string' && progress.new_string_delta) {
      newString += progress.new_string_delta
    }
    // replace family: server aliases new_string → content_delta; keep new_string in sync
    // when only the content channel moved.
    if (
      ['replace', 'str_replace', 'replace_in_file'].includes(toolNameLower) &&
      !newString &&
      content
    ) {
      newString = content
    }
    if (content.length > WRITE_STREAM_CONTENT_CAP) {
      content = content.slice(0, WRITE_STREAM_CONTENT_CAP)
    }
    if (oldString.length > WRITE_STREAM_CONTENT_CAP) {
      oldString = oldString.slice(0, WRITE_STREAM_CONTENT_CAP)
    }
    if (newString.length > WRITE_STREAM_CONTENT_CAP) {
      newString = newString.slice(0, WRITE_STREAM_CONTENT_CAP)
    }
    const contentLen =
      typeof progress.content_len === 'number' && Number.isFinite(progress.content_len)
        ? Number(progress.content_len)
        : Math.max(content.length, newString.length)
    const progressAdded = Number(progress.lines_added) || 0
    const progressRemoved = Number(progress.lines_removed) || 0
    const isReplaceTool = ['replace', 'str_replace', 'replace_in_file'].includes(toolNameLower)
    const phase = String(progress.phase ?? prevWp.phase ?? 'args').trim().toLowerCase()
    const phaseIsFinal = phase === 'writing' || phase === 'done' || phase === 'error'
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
    // Latest progress wins (reset). Never keep prevWp line counts when a new
    // event arrives — otherwise later replace calls inherit earlier +N/−N.
    let nextAdded: number
    let nextRemoved: number
    if (phaseIsFinal || typeof progress.lines_added === 'number' || typeof progress.lines_removed === 'number') {
      if (phaseIsFinal || progressAdded > 0 || progressRemoved > 0) {
        nextAdded = progressAdded
        nextRemoved = progressRemoved
      } else {
        nextAdded = fallbackAdded
        nextRemoved = fallbackRemoved
      }
    } else {
      nextAdded = fallbackAdded
      nextRemoved = fallbackRemoved
    }
    const nextWp: Record<string, unknown> = {
      path:
        typeof progress.path === 'string' && progress.path.trim()
          ? progress.path
          : prevWp.path,
      tool_name: progress.tool_name ?? prevWp.tool_name,
      phase: progress.phase ?? prevWp.phase ?? 'args',
      lines_added: nextAdded,
      lines_removed: nextRemoved,
      content,
      content_len: contentLen,
    }
    if (oldString) nextWp.old_string = oldString
    if (newString) nextWp.new_string = newString
    if (typeof progress.bytes_total === 'number' && Number.isFinite(progress.bytes_total)) {
      nextWp.bytes_total = progress.bytes_total
    } else if (typeof prevWp.bytes_total === 'number') {
      nextWp.bytes_total = prevWp.bytes_total
    }
    if (typeof progress.bytes_written === 'number' && Number.isFinite(progress.bytes_written)) {
      nextWp.bytes_written = progress.bytes_written
    } else if (typeof prevWp.bytes_written === 'number') {
      nextWp.bytes_written = prevWp.bytes_written
    }
    if (typeof progress.message === 'string' && progress.message) {
      nextWp.message = progress.message
    } else if (prevWp.message) {
      nextWp.message = prevWp.message
    }
    return {
      ...row,
      _writeProgress: nextWp,
    }
  })
  return { ...state, tools: [...tools] }
}

/** Drop bulky file bodies from SSE progress; UI only needs path/action/status while streaming. */
export function slimWorkerFileProgressEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const slim = { ...entry }
  for (const key of ['content', 'after_content', 'before_content', 'old_string', 'new_string']) {
    const raw = slim[key]
    if (typeof raw === 'string' && raw.length > 0) {
      slim[`_${key}_bytes`] = raw.length
      delete slim[key]
    }
  }
  return slim
}

/** 追加一条流式事件（唯一写入入口） */
export function reduceStreamTurn(state: StreamTurnState, event: StreamTurnEvent): StreamTurnState {
  let next: StreamTurnState
  switch (event.type) {
    case 'text_piece':
      next = applyTextPiece(state, event.piece, event.phase, event.block)
      break
    case 'reasoning_piece':
      next = applyReasoningPiece(state, event.piece, event.block)
      break
    case 'block_close':
      next = applyBlockClose(state, event.block)
      break
    case 'tools':
      next = applyToolsEvent(state, event.entries || [], event.block)
      break
    case 'tools_update':
      next = applyToolsUpdateEvent(state, event.entries || [])
      break
    case 'worker_file_progress':
      next = applyWorkerFileProgressEvent(state, event.parentToolCallId, event.entry)
      break
    case 'write_file_progress':
      next = applyWriteFileProgressEvent(state, event.toolCallId, event.progress)
      break
    case 'system_activity': {
      const detail = String(event.detail || '').trim()
      const kind = String(event.kind || '').trim().toLowerCase() || 'system'
      const now = event.ts ?? Date.now()
      const phaseHistory = [...(state.phaseHistory || [])]
      // 关闭上一个阶段（如果有）
      if (state.systemActivityStartedAt != null && state.systemActivity) {
        const last = phaseHistory[phaseHistory.length - 1]
        if (last && last.endedAt == null) {
          phaseHistory[phaseHistory.length - 1] = { ...last, endedAt: now }
        }
      }
      // 新阶段（detail 非空时才记录；空 detail = idle 清除）
      if (detail) {
        phaseHistory.push({ detail, kind, startedAt: now, endedAt: null })
      }
      next = {
        ...state,
        systemActivity: detail || null,
        systemActivityKind: detail ? kind : 'idle',
        systemActivityStartedAt: detail ? now : null,
        phaseHistory,
      }
      break
    }
    case 'media':
      next = {
        ...state,
        images: event.images?.length ? event.images : state.images,
        videos: event.videos?.length ? event.videos : state.videos,
        audios: event.audios?.length ? event.audios : state.audios,
        files: event.files?.length ? event.files : state.files,
      }
      break
    default:
      return state
  }
  if (event.type === 'text_piece' || event.type === 'reasoning_piece') {
    return capStreamTurnState(next)
  }
  return next
}

function projectDisplayTimeline(state: StreamTurnState): MessageSegment[] {
  if (hasBlockTimeline(state.blockOrder)) {
    const base = normalizeAssistantSegmentTimelineOrder(
      segmentsFromBlockState(state.blocks, state.blockOrder),
    )
    return mergeOrphanToolsIntoSegmentTimeline(base, state.tools)
  }
  return normalizeAssistantSegmentTimelineOrder(
    trimReasoningOverlappingOpenText(coerceMessageSegmentTimeline(state.timeline), state.openText),
  )
}

/** 连续 reasoning 段合并为一轮；仅 tools/text 封存后才开启下一轮（避免 思考1+思考2 并排流式） */
function reasoningFromTimeline(timeline: MessageSegment[]): {
  segments: string[]
  preview: string | null
} {
  const segments: string[] = []
  let pending = ''
  for (const seg of coerceMessageSegmentTimeline(timeline)) {
    if (seg.kind === 'reasoning') {
      pending = mergeReasoningSameRound(pending, String(seg.text ?? ''))
      continue
    }
    if (pending) {
      segments.push(pending)
      pending = ''
    }
  }
  if (pending) segments.push(pending)
  const display = segments.filter((s) => String(s).length > 0)
  return {
    segments: display,
    // 与 reasoningFromBlockState / AG-UI 一致：preview 仅当前轮次，避免活跃思考块叠加上一轮全文
    preview: display.length ? display[display.length - 1] : null,
  }
}

/** 投影为 MessageVirtualList / MessageRow 使用的 _stream 行字段 */
export function projectStreamTurn(state: StreamTurnState): {
  segments: MessageSegment[]
  text: string
  tools: unknown[]
  streamTextPhase: StreamTextPhase
  reasoningSegments: string[]
  reasoningPreview: string | null
  images: unknown[]
  videos: unknown[]
  audios: unknown[]
  files: unknown[]
  systemActivity: string | null
} {
  const useBlocks = hasBlockTimeline(state.blockOrder)
  const displayTimeline = projectDisplayTimeline(state)
  const { segments: reasoningSegments, preview: reasoningPreview } = useBlocks
    ? reasoningFromBlockState(state.blocks, state.blockOrder)
    : reasoningFromTimeline(displayTimeline)
  const streamTextPhase: StreamTextPhase =
    useBlocks && state.blockOrder.some((id) => state.blocks[id]?.kind === 'tools')
      ? 'post_tools'
      : timelineHasTools(state.timeline)
        ? 'post_tools'
        : state.textPhase
  return {
    segments: [...displayTimeline],
    text: state.openText,
    tools: [...state.tools],
    streamTextPhase,
    reasoningSegments,
    reasoningPreview,
    images: [...state.images],
    videos: [...state.videos],
    audios: [...state.audios],
    files: [...state.files],
    systemActivity: state.systemActivity ?? null,
    // @ts-ignore
    systemActivityKind: state.systemActivityKind ?? 'idle',
    systemActivityStartedAt: state.systemActivityStartedAt ?? null,
    phaseHistory: [...(state.phaseHistory || [])],
  }
}

export function finalizedTurnToCompactedPart(
  fin: ReturnType<typeof finalizeStreamTurn>,
): CompactedStreamPart {
  const segments = fin.segments?.map((seg) => {
    if (seg.kind === 'text') {
      return { kind: 'text' as const, text: capStreamTailText(seg.text, STREAM_ASSISTANT_BODY_CAP) }
    }
    if (seg.kind === 'reasoning') {
      return {
        kind: 'reasoning' as const,
        text: capStreamTailText(seg.text, STREAM_REASONING_TEXT_CAP),
      }
    }
    return seg
  })
  const reasoningPreview =
    fin.reasoningPreview != null
      ? capStreamTailText(String(fin.reasoningPreview), STREAM_REASONING_TEXT_CAP)
      : fin.reasoningPreview
  return {
    segments,
    text: capStreamTailText(fin.text, STREAM_ASSISTANT_BODY_CAP),
    tools: [...fin.tools],
    reasoningSegments: fin.reasoningSegments.map((r) =>
      capStreamTailText(String(r || ''), STREAM_REASONING_TEXT_CAP),
    ),
    reasoningPreview,
    images: [...fin.images],
    videos: [...fin.videos],
    audios: [...fin.audios],
    files: [...fin.files],
  }
}

function mergeToolLists(base: unknown[], extra: unknown[]): unknown[] {
  const out = [...base]
  for (const t of extra) {
    if (t) upsertTool(out, t)
  }
  return out
}

function mergeMediaLists<T>(a: T[], b: T[]): T[] {
  if (!a.length) return [...b]
  if (!b.length) return [...a]
  return [...a, ...b]
}

/** 将封存段合并回 turn（final 落库 / 展示用；时间线按发生顺序：封存段在前，当前段在后） */
export function mergeCompactedPartsIntoTurn(
  parts: CompactedStreamPart[],
  turn: StreamTurnState,
): StreamTurnState {
  if (!parts?.length) return turn
  let timeline: MessageSegment[] = []
  let tools: unknown[] = []
  let images: unknown[] = []
  let videos: unknown[] = []
  let audios: unknown[] = []
  let files: unknown[] = []
  for (const part of parts) {
    if (part.segments?.length) timeline = [...timeline, ...part.segments]
    else if (String(part.text || '').trim()) {
      timeline = [...timeline, { kind: 'text', text: part.text }]
    }
    tools = mergeToolLists(tools, part.tools)
    images = mergeMediaLists(images, part.images)
    videos = mergeMediaLists(videos, part.videos)
    audios = mergeMediaLists(audios, part.audios)
    files = mergeMediaLists(files, part.files)
  }
  timeline = normalizeAssistantSegmentTimelineOrder(
    dedupeToolsTimelineSegments([
      ...timeline,
      ...coerceMessageSegmentTimeline(turn.timeline),
    ]),
  )
  tools = mergeToolLists(tools, turn.tools)
  return {
    ...turn,
    timeline,
    tools,
    images: mergeMediaLists(images, turn.images),
    videos: mergeMediaLists(videos, turn.videos),
    audios: mergeMediaLists(audios, turn.audios),
    files: mergeMediaLists(files, turn.files),
  }
}

/** 前一轮 strip 包（用于 merged stream 过滤 stale 工具 id） */
export interface PriorTurnStripBundle {
  toolIds?: string[]
  [key: string]: unknown
}

/** 本轮 intentional 工具 id 不应被 stale 过滤（compacted 同轮展示 / final 落库） */
export function priorTurnStripForMergedStream(
  strip: PriorTurnStripBundle,
  mergedTurn: StreamTurnState,
): PriorTurnStripBundle {
  const keep = new Set(collectToolCallIdsFromTurn(mergedTurn))
  if (!keep.size || !strip.toolIds?.length) return strip
  const toolIds = strip.toolIds.filter((id: string) => !keep.has(String(id || '').trim()))
  if (toolIds.length === strip.toolIds.length) return strip
  return { ...strip, toolIds }
}

export function staleToolIdsExcludingTurnTools(
  staleIds: readonly string[],
  turn: StreamTurnState,
): string[] {
  const keep = new Set(collectToolCallIdsFromTurn(turn))
  if (!keep.size) return [...staleIds]
  return staleIds.filter((id) => !keep.has(String(id || '').trim()))
}

/** 流式气泡：封存段 + 当前 turn 合并投影（避免 partial rows 割裂 UI） */
export function projectStreamTurnWithCompacted(
  state: StreamTurnState,
  compactedParts: CompactedStreamPart[] | undefined | null,
): ReturnType<typeof projectStreamTurn> {
  return projectStreamTurn(mergeCompactedPartsIntoTurn(compactedParts || [], state))
}

export function streamTurnHasCompactedContent(
  compactedParts: CompactedStreamPart[] | undefined | null,
): boolean {
  if (!compactedParts?.length) return false
  return compactedParts.some(
    (p) =>
      !!(p.segments?.length || String(p.text || '').trim() || p.tools?.length || p.reasoningPreview),
  )
}

export function collectToolCallIdsFromTurn(state: StreamTurnState): string[] {
  const ids = new Set<string>()
  for (const t of state.tools || []) {
    const o = t as Record<string, unknown>
    const id = String(o.id || o.tool_call_id || '').trim()
    if (id) ids.add(id)
  }
  return [...ids]
}

/** 新一轮 tool_call 开始（timeline 已有 tools 段且 entries 含新 id） */
export function isNewToolRoundStarting(state: StreamTurnState, entries: unknown[]): boolean {
  if (!entries?.length || !timelineHasTools(state.timeline)) return false
  const existingIds = collectToolIdsFromTimeline(state.timeline)
  return collectNewToolIds(state.tools, entries).some((id) => !existingIds.has(id))
}

function hasPreToolModelContent(state: StreamTurnState): boolean {
  if (String(state.openText || '').trim()) return true
  return (state.timeline || []).some((s) => s.kind === 'reasoning' || s.kind === 'text')
}

function lastToolsSegmentIds(timeline: MessageSegment[]): string[] {
  const idx = lastToolsSegmentIndex(timeline)
  if (idx < 0) return []
  const seg = timeline[idx]
  return seg?.kind === 'tools' ? [...(seg.ids || [])] : []
}

/** 时间线最后一段 tools 是否均已结束（结果已落库，可释放缓冲） */
export function areLastTimelineToolsComplete(state: StreamTurnState): boolean {
  const ids = lastToolsSegmentIds(state.timeline)
  if (!ids.length) return false
  const tools = state.tools || []
  for (const rawId of ids) {
    const id = String(rawId || '').trim()
    if (!id) continue
    const row = tools.find((t) => {
      const o = t as Record<string, unknown>
      return String(o.id || o.tool_call_id || '').trim() === id
    }) as Record<string, unknown> | undefined
    if (!row || isToolRunning(row)) return false
  }
  return true
}

function timelineAfterLastTools(timeline: MessageSegment[]): MessageSegment[] {
  const idx = lastToolsSegmentIndex(timeline)
  return idx < 0 ? [] : timeline.slice(idx + 1)
}

export type StreamReleaseTrigger =
  | { kind: 'tools'; entries: unknown[] }
  | { kind: 'reasoning_piece'; piece: string }
  | { kind: 'text_piece'; piece: string; phase?: StreamTextPhase | null }

function shouldReleaseBeforeTools(state: StreamTurnState, entries: unknown[]): boolean {
  if (!entries?.length || !streamDeltaShouldMergeTools(state, entries)) return false
  if (!timelineHasTools(state.timeline)) {
    return hasPreToolModelContent(state) && collectNewToolIds(state.tools, entries).length > 0
  }
  return isNewToolRoundStarting(state, entries)
}

/** 工具全部完成后，模型开始下一段 SSE（思考或正文） */
// @ts-ignore
function shouldReleaseBeforePostToolModel(
  state: StreamTurnState,
  piece: string,
): boolean {
  if (!String(piece || '').trim()) return false
  if (!timelineHasTools(state.timeline)) return false
  if (!areLastTimelineToolsComplete(state)) return false
  if (String(state.openText || '').trim()) return false
  const afterTools = timelineAfterLastTools(state.timeline)
  return !afterTools.some((s) => s.kind === 'reasoning' || s.kind === 'text')
}

/**
 * 是否应在处理下一条 SSE 前释放流式缓冲。
 * 仅在新一轮 tools 开始前释放；post-tool 正文/思考仍与本轮工具同属「最新不确定段」。
 */
export function shouldReleaseStreamBufferBeforeEvent(
  state: StreamTurnState,
  trigger: StreamReleaseTrigger,
): boolean {
  if (hasBlockTimeline(state.blockOrder)) return false
  if (trigger.kind !== 'tools') return false
  return shouldReleaseBeforeTools(state, trigger.entries)
}

/**
 * 封存当前轮流式缓冲并清空内存：TranscriptMiddleware 已落库，前端只保留最新一段 SSE。
 * 返回 sealed 供写入 rows / priorTurnStrip；fresh 供继续接收新工具批次。
 */
export function drainStreamTurnRoundBuffer(state: StreamTurnState): {
  sealed: StreamTurnState
  releasedToolIds: string[]
  fresh: StreamTurnState
} {
  const sealed = sealOpenText(state)
  const releasedToolIds = collectToolCallIdsFromTurn(sealed)
  const fresh: StreamTurnState = {
    ...emptyStreamTurn(),
    images: [...sealed.images],
    videos: [...sealed.videos],
    audios: [...sealed.audios],
    files: [...sealed.files],
    textPhase: releasedToolIds.length || timelineHasTools(sealed.timeline) ? 'post_tools' : 'pre_tools',
    reasoningPendingNewRound: true,
  }
  return { sealed, releasedToolIds, fresh }
}

/** 丢弃已停止/已封存轮次的 tool_call（values 快照回灌防护） */
export function filterStaleToolEntries(entries: unknown[], staleIds: readonly string[]): unknown[] {
  if (!Array.isArray(entries) || !entries.length) return entries || []
  if (!staleIds?.length) return entries
  const blocked = new Set(staleIds.map((x) => String(x || '').trim()).filter(Boolean))
  if (!blocked.size) return entries
  return entries.filter((e) => {
    const o = e as Record<string, unknown>
    const id = String(o.id || o.tool_call_id || '').trim()
    return !id || !blocked.has(id)
  })
}

/** values 纯文本 delta 常附带整轮 tool_calls；有新 id 或段外 id 时才合并进时间线 */
export function streamDeltaShouldMergeTools(state: StreamTurnState, entries: unknown[]): boolean {
  if (!entries?.length) return false
  if (collectNewToolIds(state.tools, entries).length > 0) return true
  const segIds = hasBlockTimeline(state.blockOrder)
    ? collectToolIdsFromBlockState(state.blocks, state.blockOrder)
    : collectToolIdsFromTimeline(state.timeline)
  for (const r of entries) {
    const e = r as Record<string, unknown>
    const id = String(e.id || e.tool_call_id || '').trim()
    if (id && !segIds.has(id)) return true
  }
  return false
}

/** evf piece：网关发什么就拼什么，不在此过滤（换行/空格/仅 \\n 片段均保留） */
export function shouldAcceptStreamTextPiece(_state: StreamTurnState, piece: string): boolean {
  return String(piece ?? '').length > 0
}

/**
 * Prior-turn strip 之后是否仍应入流。
 * 只丢真正空串；保留 ``\\n`` / ``\\n\\n`` / 空格等（否则 markdown 段落分隔会在独立 delta 时被吃掉）。
 */
export function shouldKeepStreamDeltaAfterStrip(cleaned: string): boolean {
  return String(cleaned ?? '').length > 0
}

export function streamTurnHasVisibleContent(state: StreamTurnState): boolean {
  const p = projectStreamTurn(state)
  const hasReasoning = !!(p.reasoningPreview || p.reasoningSegments.length)
  return !!(
    String(p.systemActivity || '').trim() ||
    String(p.text || '').trim() ||
    (p.segments || []).some((s) => s.kind === 'text' && String(s.text || '').trim()) ||
    hasReasoning ||
    (p.segments || []).some((s) => s.kind === 'tools') ||
    (p.tools || []).length ||
    (p.images || []).length ||
    (p.videos || []).length ||
    (p.audios || []).length ||
    (p.files || []).length
  )
}

function collectToolNamesInSegments(tools: unknown[], segments: MessageSegment[]): Set<string> {
  const segIds = collectToolIdsFromTimeline(segments)
  const names = new Set<string>()
  for (const t of tools) {
    const o = t as Record<string, unknown>
    const rid = o.id != null && String(o.id).trim() !== '' ? String(o.id).trim() : ''
    const rtc =
      o.tool_call_id != null && String(o.tool_call_id).trim() !== ''
        ? String(o.tool_call_id).trim()
        : ''
    if (!rid && !rtc) continue
    if (!segIds.has(rid) && !segIds.has(rtc)) continue
    const nm = String(o.name || o.tool_name || o.toolName || '')
      .trim()
      .toLowerCase()
    if (nm && nm !== 'tool') names.add(nm)
  }
  return names
}

function lastToolsSegmentIndex(timeline: MessageSegment[]): number {
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i].kind === 'tools') return i
  }
  return -1
}

/**
 * final 落库：去掉流式封存正文，只保留一条 final（plan 段在 tools 之前可保留）。
 */
function mergeAuthoritativeFinalIntoTimeline(
  timeline: MessageSegment[],
  authoritative: string,
  tools: unknown[],
): MessageSegment[] {
  const auth = sanitizeStreamBodyText(String(authoritative || '')).trim()
  if (!auth || isToolCallPreambleAssistantNoise(auth, tools)) return timeline

  const firstToolsIdx = firstToolsSegmentIndex(timeline)
  let out: MessageSegment[]

  if (firstToolsIdx < 0) {
    out = timeline.filter((s) => s.kind !== 'text')
  } else {
    const prePlain = preToolsTextPlain(timeline, firstToolsIdx)
    const dropPreTool = authRedundantWithPreTool(prePlain, auth)
    let seenTools = false
    out = []
    for (const seg of timeline) {
      if (seg.kind === 'tools') {
        seenTools = true
        out.push(seg)
        continue
      }
      if (seg.kind === 'text') {
        if (seenTools) continue
        if (dropPreTool) continue
        out.push(seg)
        continue
      }
      out.push(seg)
    }
  }

  out.push({ kind: 'text', text: auth })
  return out
}

/** final：封存 openText，合并权威全文，补齐 orphan 工具段 */
export function finalizeStreamTurn(
  state: StreamTurnState,
  authoritativeText?: string,
): {
  segments: MessageSegment[] | undefined
  text: string
  tools: unknown[]
  reasoningSegments: string[]
  reasoningPreview: string | null
  images: unknown[]
  videos: unknown[]
  audios: unknown[]
  files: unknown[]
} {
  let work: StreamTurnState
  if (hasBlockTimeline(state.blockOrder)) {
    const flushed = flushOpenTextIntoBlockState(state)
    work = { ...state, blocks: flushed.blocks, blockOrder: flushed.blockOrder, openText: flushed.openText }
  } else {
    work = sealOpenText(state)
  }
  let timeline = [...work.timeline]
  const tools = [...work.tools]
  const useBlocks = hasBlockTimeline(work.blockOrder)
  const auth = sanitizeStreamBodyText(String(authoritativeText || work.openText || ''))

  if (!useBlocks) {
    timeline = dedupeToolsTimelineSegments(timeline)
    const seenInSeg = collectToolIdsFromTimeline(timeline)
    const allToolsAccountedFor = tools.every((t) => {
      const o = t as Record<string, unknown>
      const id = String(o.id || o.tool_call_id || '').trim()
      return !id || seenInSeg.has(id)
    })
    const namesInSeg = collectToolNamesInSegments(tools, timeline)
    const remaining = tools
      .map((t) => {
        const o = t as Record<string, unknown>
        return {
          id: String(o.id || o.tool_call_id || '').trim(),
          name: String(o.name || o.tool_name || o.toolName || '').trim().toLowerCase(),
        }
      })
      .filter((x) => x.id)
      .filter((x) => !seenInSeg.has(x.id))
      .filter((x) => !(x.name && namesInSeg.has(x.name)))
      .map((x) => x.id)
    const remainingWithRows = remaining.filter((id) => {
      return tools.some((t) => {
        const o = t as Record<string, unknown>
        return String(o.id || o.tool_call_id || '').trim() === id
      })
    })
    if (remainingWithRows.length && !allToolsAccountedFor) {
      timeline = dedupeToolsTimelineSegments(
        insertOrphanToolsIntoSegments(timeline, remainingWithRows),
      )
    }

    const authLegacy = auth
    if (authLegacy) {
      timeline = mergeAuthoritativeFinalIntoTimeline(timeline, authLegacy, tools)
      work = { ...work, openText: '' }
    }

    timeline = trimReasoningOverlappingOpenText(timeline, work.openText)
    timeline = normalizeAssistantSegmentTimelineOrder(timeline)
  }

  const blockSegments = useBlocks ? projectDisplayTimeline(work) : []
  const finalTimeline = dedupeToolsTimelineSegments(
    useBlocks ? blockSegments : timeline,
  )

  const { segments: reasoningSegments, preview: reasoningPreview } = useBlocks
    ? reasoningFromBlockState(work.blocks, work.blockOrder)
    : reasoningFromTimeline(finalTimeline)

  const segmentPlain = flattenStreamDisplayText(finalTimeline, '').trim()
  // 正文已在 segments：禁止 row.text 再渲染第二遍（流式封存 + final 重复的根源）
  let textOut = ''
  if (!finalTimeline.some((s) => s.kind === 'text')) {
    textOut = auth || segmentPlain
  } else if (auth && segmentPlain && !assistantBodiesLooselySame(auth, segmentPlain)) {
    const tail = auth.startsWith(segmentPlain) ? auth.slice(segmentPlain.length).trim() : auth
    if (tail && !assistantBodiesLooselySame(tail, '')) textOut = tail
  }

  return {
    segments: finalTimeline.length ? finalTimeline : undefined,
    text: textOut,
    tools,
    reasoningSegments,
    reasoningPreview,
    images: [...work.images],
    videos: [...work.videos],
    audios: [...work.audios],
    files: [...work.files],
  }
}