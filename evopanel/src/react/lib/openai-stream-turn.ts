/**
 * OpenAI ``chat.completion.chunk`` → ``StreamTurnEvent``（legacy wire；主路径已迁移至 AG-UI）。
 * 仅当 localStorage EVOFLOW_STREAM_FORMAT=openai 时使用。
 */
import {
  mergeStreamingToolCallArgStrings,
  normalizeChatToolPayloadToEntries,
} from '../../lib/chat-normalize.js'
import { fixReasoningStreamText } from './turn-text-isolation.js'
import type { StreamTurnEvent, StreamTextPhase } from './stream-turn-engine.js'

export type OpenAiCompletionChunk = {
  object?: string
  choices?: Array<{
    index?: number
    delta?: {
      content?: string
      content_phase?: 'pre_tools' | 'post_tools' | string
      reasoning_content?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
}

export type OpenAiStreamLane = {
  toolCallAccumById: Map<string, Record<string, unknown>>
  toolCallIndexToKey: Map<number, string>
  lastToolEmitSig: Map<string, string>
  lastToolFnLen: Map<string, number>
  /** 已下发过 ``tools`` 段的 id */
  emittedToolCallIds: Set<string>
  textPhase: StreamTextPhase
}

export function createOpenAiStreamLane(): OpenAiStreamLane {
  return {
    toolCallAccumById: new Map(),
    toolCallIndexToKey: new Map(),
    lastToolEmitSig: new Map(),
    lastToolFnLen: new Map(),
    emittedToolCallIds: new Set(),
    textPhase: 'pre_tools',
  }
}

function mergeToolCallAccum(
  prev: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): Record<string, unknown> {
  if (!prev) return { ...next }
  const out: Record<string, unknown> = { ...prev }
  const pfn = prev.function as Record<string, unknown> | undefined
  const nfn = next.function as Record<string, unknown> | undefined
  if (pfn || nfn) {
    const fn: Record<string, unknown> = { ...(pfn || {}), ...(nfn || {}) }
    const ps = pfn && typeof pfn.arguments === 'string' ? pfn.arguments : ''
    const ns = nfn && typeof nfn.arguments === 'string' ? nfn.arguments : ''
    if (ps || ns) fn.arguments = mergeStreamingToolCallArgStrings(ps, ns)
    if (!String(fn.name || '').trim() && pfn && String(pfn.name || '').trim()) {
      fn.name = pfn.name
    }
    out.function = fn
  }
  for (const k of Object.keys(next)) {
    if (k === 'function') continue
    const v = next[k]
    if (v === undefined) continue
    if ((k === 'id' || k === 'tool_call_id' || k === 'name') && (v == null || String(v).trim() === '')) {
      continue
    }
    out[k] = v
  }
  return out
}

function resolveToolCallAccumKey(lane: OpenAiStreamLane, tc: Record<string, unknown>): string {
  const id = String(tc.id ?? tc.tool_call_id ?? '').trim()
  const idxRaw = tc.index
  const idx = typeof idxRaw === 'number' && Number.isFinite(idxRaw) ? idxRaw : null
  if (id) {
    if (idx != null) {
      const prevKey = lane.toolCallIndexToKey.get(idx)
      if (prevKey && prevKey !== id && lane.toolCallAccumById.has(prevKey)) {
        if (prevKey.startsWith('idx:') || prevKey.startsWith('anon:')) {
          const orphan = lane.toolCallAccumById.get(prevKey)
          const existing = lane.toolCallAccumById.get(id)
          lane.toolCallAccumById.set(id, mergeToolCallAccum(existing, orphan || {}))
          lane.toolCallAccumById.delete(prevKey)
        }
      }
      lane.toolCallIndexToKey.set(idx, id)
    }
    return id
  }
  if (idx != null && lane.toolCallIndexToKey.has(idx)) {
    return lane.toolCallIndexToKey.get(idx)!
  }
  const name = String(tc.name || (tc.function as Record<string, unknown> | undefined)?.name || '').trim()
  if (idx != null) return `idx:${idx}:${name || 'tool'}`
  return `anon:${name || 'tool'}`
}

function toolCallToEntry(tc: Record<string, unknown>): Record<string, unknown> {
  const fn = (tc.function as Record<string, unknown> | undefined) || {}
  const name = String(tc.name || fn.name || 'tool').trim() || 'tool'
  let input: unknown = null
  const argsRaw = fn.arguments
  if (typeof argsRaw === 'string' && argsRaw.trim()) {
    try {
      input = JSON.parse(argsRaw)
    } catch {
      input = argsRaw
    }
  }
  const id = String(tc.id ?? tc.tool_call_id ?? '').trim()
  return {
    id: id || undefined,
    tool_call_id: id || undefined,
    name,
    tool_name: name,
    function: tc.function,
    input,
    status: 'running',
  }
}

function toolCallDeltaEvents(lane: OpenAiStreamLane, tc: Record<string, unknown>): StreamTurnEvent[] {
  const key = resolveToolCallAccumKey(lane, tc)
  const prev = lane.toolCallAccumById.get(key)
  const merged = mergeToolCallAccum(prev, tc)
  lane.toolCallAccumById.set(key, merged)
  const sig = (() => {
    try {
      return JSON.stringify(merged)
    } catch {
      return key
    }
  })()
  const fn = merged.function as Record<string, unknown> | undefined
  const fnLen = fn && typeof fn.arguments === 'string' ? fn.arguments.length : 0
  const prevSig = lane.lastToolEmitSig.get(key) ?? ''
  const prevFnLen = lane.lastToolFnLen.get(key) ?? 0
  if (sig === prevSig && fnLen <= prevFnLen) return []
  lane.lastToolEmitSig.set(key, sig)
  lane.lastToolFnLen.set(key, fnLen)

  const entry = toolCallToEntry(merged)
  const canonId = String(entry.id ?? entry.tool_call_id ?? key).trim()
  if (!canonId) return []
  const isNew = !lane.emittedToolCallIds.has(canonId)
  if (isNew) lane.emittedToolCallIds.add(canonId)
  lane.textPhase = 'post_tools'
  return [{ type: isNew ? 'tools' : 'tools_update', entries: [entry] }]
}

/** 单帧 OpenAI chunk → 0..N 个 StreamTurnEvent */
export function openAiChunkToStreamTurnEvents(
  chunk: OpenAiCompletionChunk,
  lane: OpenAiStreamLane,
): StreamTurnEvent[] {
  if (!chunk || chunk.object !== 'chat.completion.chunk') return []
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined
  if (!choice?.delta || typeof choice.delta !== 'object') return []
  const delta = choice.delta
  const out: StreamTurnEvent[] = []

  if (typeof delta.content === 'string' && delta.content) {
    const phaseRaw = String(delta.content_phase || '').trim()
    let phase: StreamTextPhase = lane.textPhase
    if (phaseRaw === 'post_tools') phase = 'post_tools'
    else if (phaseRaw === 'pre_tools') phase = 'pre_tools'
    if (phase === 'post_tools') lane.textPhase = 'post_tools'
    out.push({
      type: 'text_piece',
      piece: delta.content,
      phase,
    })
  }
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
    const piece = fixReasoningStreamText(delta.reasoning_content)
    if (piece) out.push({ type: 'reasoning_piece', piece })
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const raw of delta.tool_calls) {
      if (!raw || typeof raw !== 'object') continue
      const fn = raw.function && typeof raw.function === 'object' ? raw.function : {}
      out.push(
        ...toolCallDeltaEvents(lane, {
          index: raw.index,
          id: raw.id,
          tool_call_id: raw.id,
          name: fn.name,
          function: { name: fn.name || '', arguments: fn.arguments || '' },
        }),
      )
    }
  }
  return out
}

/** ``event: meta`` 中可进 turn engine 的部分 */
export function openAiMetaToStreamTurnEvents(meta: Record<string, unknown>): StreamTurnEvent[] {
  const t = String(meta.type || '').trim()
  if (t === 'tool_result') {
    const tool = meta.tool as Record<string, unknown> | undefined
    const toolCallId = String(meta.tool_call_id ?? tool?.tool_call_id ?? tool?.id ?? '').trim()
    if (!toolCallId) return []
    const name = String(meta.name ?? tool?.name ?? tool?.tool_name ?? 'tool')
    const entries = normalizeChatToolPayloadToEntries({
      toolCallId,
      name,
      data: {
        type: 'tool',
        role: 'tool',
        tool_call_id: toolCallId,
        name,
        content: meta.content ?? tool?.content,
        status: meta.status ?? tool?.status,
        ...(tool && typeof tool === 'object' ? tool : {}),
      },
    })
    if (!entries.length) return []
    return [{ type: 'tools_update', entries }]
  }
  if (t === 'write_file_progress') {
    const toolCallId = String(meta.tool_call_id || '').trim()
    if (!toolCallId) return []
    return [
      {
        type: 'write_file_progress',
        toolCallId,
        progress: {
          path: typeof meta.path === 'string' ? meta.path : '',
          tool_name: typeof meta.tool_name === 'string' ? meta.tool_name : '',
          lines_added: Number(meta.lines_added) || 0,
          lines_removed: Number(meta.lines_removed) || 0,
          content_delta: typeof meta.content_delta === 'string' ? meta.content_delta : undefined,
          old_string_delta:
            typeof meta.old_string_delta === 'string' ? meta.old_string_delta : undefined,
          content_len:
            typeof meta.content_len === 'number' && Number.isFinite(meta.content_len)
              ? meta.content_len
              : undefined,
        },
      },
    ]
  }
  if (t === 'activity') {
    const detail = String(meta.detail || '').trim()
    if (!detail) return []
    return [
      {
        type: 'system_activity',
        detail,
        kind: typeof meta.kind === 'string' ? meta.kind : undefined,
        toolName: typeof meta.tool_name === 'string' ? meta.tool_name : undefined,
      },
    ]
  }
  return []
}

export type OpenAiMetaSideEffect =
  | { kind: 'thread_state'; payload: Record<string, unknown> }
  | { kind: 'usage'; usage: Record<string, unknown> }
  | { kind: 'run_end'; payload: Record<string, unknown> }
  | { kind: 'custom'; chunk: Record<string, unknown> }
  | { kind: 'error'; error: unknown }
  | { kind: 'aborted'; reason?: string }

export function openAiMetaSideEffect(meta: Record<string, unknown>): OpenAiMetaSideEffect | null {
  const t = String(meta.type || '').trim()
  if (t === 'thread_state') return { kind: 'thread_state', payload: meta }
  if (t === 'usage' && meta.usage && typeof meta.usage === 'object') {
    return { kind: 'usage', usage: meta.usage as Record<string, unknown> }
  }
  if (t === 'run_end') return { kind: 'run_end', payload: meta }
  if (t === 'custom' && meta.chunk && typeof meta.chunk === 'object') {
    return { kind: 'custom', chunk: meta.chunk as Record<string, unknown> }
  }
  if (t === 'error') return { kind: 'error', error: meta.error ?? meta }
  if (t === 'aborted') return { kind: 'aborted', reason: String(meta.reason || '') }
  return null
}
