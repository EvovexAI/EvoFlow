/** Parse stored vendor request/response JSON for EvoPanel detail drawer. */

import { normalizeHistoryRole } from '../../../lib/chat-normalize.js'
import {
  estimateTextStats,
  parseContentStats,
  parseToolContentStats,
  type ContentStats,
  type ToolContentStat,
  toolStatsFromWireTools,
} from './obs-text-stats.js'

export type { ContentStats, ToolContentStat }

export type ParsedRequestViews = {
  raw: unknown
  vendorRequest: Record<string, unknown> | null
  systemPrompt: string
  userLatest: string
  /** Tool schema names from vendor request ``tools`` array. */
  requestToolNames: string[]
  systemPromptStats: ContentStats | null
  userLatestStats: ContentStats | null
  requestToolStats: ToolContentStat[]
  requestToolsTokensTotal: number | null
  thinkingContext: ThinkingContextView | null
}

export type ThinkingContextView = {
  thinkingEnabled: boolean | null
  reasoningEffort: string | null
  reasoningEffortInferred: string | null
  thinkingType: string | null
  thinkingBudgetTokens: number | null
  sessionMode: string | null
  label: string
  vendorThinking: Record<string, unknown> | null
}

export type ParsedToolCall = {
  id: string
  name: string
  arguments: unknown
  raw: unknown
}

export type ParsedResponseViews = {
  raw: unknown
  assistantContent: string
  /** Thinking / reasoning stream when the vendor puts it in ``reasoning_content``. */
  reasoningContent: string
  toolCalls: ParsedToolCall[]
  errorMessage: string | null
  finishReason: string | null
  /** User-facing note when output hit length with thinking-only body. */
  truncationNote: string | null
  assistantStats: ContentStats | null
  reasoningStats: ContentStats | null
}

export function parseJsonValue(raw: unknown): unknown {
  if (raw == null) return null
  if (typeof raw === 'string') {
    const t = raw.trim()
    if (!t) return null
    try {
      return JSON.parse(t) as unknown
    } catch {
      const loose = tryParseObsJsonLoose(t)
      if (loose != null) return loose
      return raw
    }
  }
  return raw
}

const OBS_JSON_TRUNCATION_SUFFIXES = [
  /\n… \[truncated\]\s*$/u,
  /\n\.\.\.<truncated[^>]*>\s*$/u,
]

function stripObsJsonTruncationMarkers(text: string): string {
  let out = text.trim()
  for (const re of OBS_JSON_TRUNCATION_SUFFIXES) {
    out = out.replace(re, '')
  }
  return out
}

/** Best-effort parse when SQLite / roundtrip caps cut JSON mid-structure. */
export function tryParseObsJsonLoose(text: string): unknown | null {
  const base = stripObsJsonTruncationMarkers(text)
  if (!base) return null
  try {
    return JSON.parse(base) as unknown
  } catch {
    /* continue */
  }
  const closers = ['', ']', ']}', '}]', '"}]', '"]}', '"]}]', '"}]}', '"}]}]', '}']
  for (const suffix of closers) {
    try {
      return JSON.parse(base + suffix) as unknown
    } catch {
      /* continue */
    }
  }
  return null
}

function decodeJsonStringLiteral(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string
  } catch {
    return raw
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
}

function langChainClassFromMessage(msg: unknown): string {
  if (!msg || typeof msg !== 'object') return ''
  const id = (msg as Record<string, unknown>).id
  if (Array.isArray(id)) return String(id[id.length - 1] || '')
  return ''
}

function messageTypeHint(msg: unknown, body: Record<string, unknown>): unknown {
  if (body.type != null) return body.type
  const lc = langChainClassFromMessage(msg)
  if (lc.includes('HumanMessage')) return 'human'
  if (lc.includes('SystemMessage')) return 'system'
  if (lc.includes('AIMessage')) return 'ai'
  if (lc.includes('ToolMessage')) return 'tool'
  return (msg as { type?: unknown })?.type
}

function systemPromptFromWrap(wrap: Record<string, unknown> | null | undefined): string {
  if (!wrap) return ''
  for (const key of ['system_prompt_full', 'system_prompt_preview'] as const) {
    const v = wrap[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

function latestUserFromWrap(wrap: Record<string, unknown> | null | undefined): string {
  if (!wrap) return ''
  const v = wrap.latest_user_preview
  return typeof v === 'string' && v.trim() ? v.trim() : ''
}

function requestToolNamesFromWrap(wrap: Record<string, unknown> | null | undefined): string[] {
  if (!wrap) return []
  const pre = wrap.request_tool_names
  if (!Array.isArray(pre)) return []
  const out = pre.map((n) => String(n).trim()).filter(Boolean)
  return out.length ? [...new Set(out)] : []
}

function extractSystemPromptFromJsonText(text: string): string {
  const full = text.match(/"system_prompt_full"\s*:\s*"((?:\\.|[^"\\])*)"/s)
  if (full?.[1]) {
    const decoded = decodeJsonStringLiteral(full[1]).trim()
    if (decoded) return decoded
  }
  const preview = text.match(/"system_prompt_preview"\s*:\s*"((?:\\.|[^"\\])*)"/s)
  if (preview?.[1]) {
    const decoded = decodeJsonStringLiteral(preview[1]).trim()
    if (decoded) return decoded
  }
  const ins = text.match(/"instructions"\s*:\s*"((?:\\.|[^"\\])*)"/s)
  if (ins?.[1]) {
    const decoded = decodeJsonStringLiteral(ins[1]).trim()
    if (decoded) return decoded
  }
  const sys = text.match(/"system"\s*:\s*"((?:\\.|[^"\\])*)"/s)
  if (sys?.[1]) {
    const decoded = decodeJsonStringLiteral(sys[1]).trim()
    if (decoded) return decoded
  }
  return ''
}

function extractLatestUserFromJsonText(text: string): string {
  const re = /"role"\s*:\s*"(?:user|human)"[\s\S]*?"content"\s*:\s*"((?:\\.|[^"\\])*)"/gi
  let last = ''
  for (const m of text.matchAll(re)) {
    const decoded = decodeJsonStringLiteral(m[1] || '').trim()
    if (decoded) last = decoded
  }
  return last
}

function extractToolNamesFromJsonText(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const toolsIdx = text.indexOf('"tools"')
  const slice = toolsIdx >= 0 ? text.slice(toolsIdx, toolsIdx + 120_000) : text
  const reFn = /"function"\s*:\s*\{[\s\S]*?"name"\s*:\s*"([^"\\]+)"/g
  for (const m of slice.matchAll(reFn)) {
    const name = String(m[1] || '').trim()
    if (name && !seen.has(name)) {
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

function extractAssistantFromResponseJsonText(text: string): string {
  const parts: string[] = []
  for (const m of text.matchAll(/"text"\s*:\s*"((?:\\.|[^"\\])*)"/g)) {
    const decoded = decodeJsonStringLiteral(m[1] || '').trim()
    if (decoded) parts.push(decoded)
  }
  for (const m of text.matchAll(
    /"role"\s*:\s*"(?:assistant|ai)"[\s\S]*?"content"\s*:\s*"((?:\\.|[^"\\])*)"/gi,
  )) {
    const decoded = decodeJsonStringLiteral(m[1] || '').trim()
    if (decoded) parts.push(decoded)
  }
  return [...new Set(parts.filter(Boolean))].join('\n\n')
}

function messageContentToPlainText(content: unknown): string {
  if (content == null) return ''
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (typeof block === 'string' && block.trim()) {
        parts.push(block.trim())
        continue
      }
      if (block && typeof block === 'object') {
        const row = block as Record<string, unknown>
        const typ = String(row.type || '').toLowerCase()
        const t = row.text
        if (typeof t === 'string' && t.trim()) parts.push(t.trim())
        else if (['text', 'input_text', 'output_text'].includes(typ) && typeof t === 'string') {
          parts.push(String(t).trim())
        }
      }
    }
    return parts.join('\n').trim()
  }
  if (typeof content === 'object') {
    const obj = content as Record<string, unknown>
    if (Array.isArray(obj.parts)) return messageContentToPlainText(obj.parts)
    if (typeof obj.text === 'string') return obj.text.trim()
  }
  return String(content).trim()
}

/** @deprecated use messageContentToPlainText */
function contentToText(content: unknown): string {
  return messageContentToPlainText(content)
}

function anthropicStyleSystemToText(system: unknown): string {
  if (system == null) return ''
  if (typeof system === 'string') return system.trim()
  if (Array.isArray(system)) {
    return system.map((b) => messageContentToPlainText(b)).filter(Boolean).join('\n\n')
  }
  if (typeof system === 'object') return messageContentToPlainText(system)
  return ''
}

function dedupeIdenticalSystemSegments(segments: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of segments) {
    const key = String(s || '').trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

function unwrapStoredMessage(msg: unknown): Record<string, unknown> | null {
  if (!msg || typeof msg !== 'object') return null
  const outer = msg as Record<string, unknown>
  const data = outer.data
  const typ = String(outer.type || '').trim()
  const typLower = typ.toLowerCase()
  if (data && typeof data === 'object') {
    if (
      typLower === 'ai' ||
      typLower === 'human' ||
      typLower === 'tool' ||
      typLower === 'system' ||
      typLower === 'aimessagechunk' ||
      typ === 'AIMessageChunk'
    ) {
      return data as Record<string, unknown>
    }
  }
  const kwargs = outer.kwargs
  if (kwargs && typeof kwargs === 'object') {
    return kwargs as Record<string, unknown>
  }
  return outer
}

function messageRole(msg: unknown): string {
  const body = unwrapStoredMessage(msg)
  if (!body) return 'assistant'
  return normalizeHistoryRole({ ...body, type: messageTypeHint(msg, body) })
}

function isSystemLikeMessage(msg: unknown, body: Record<string, unknown>): boolean {
  const roleRaw = String(body.role || '').trim().toLowerCase()
  if (roleRaw === 'system' || roleRaw === 'developer') return true
  const outerType = String((msg as { type?: unknown })?.type || body.type || '')
    .trim()
    .toLowerCase()
  if (outerType === 'system' || outerType === 'systemmessage') return true
  return messageRole(msg) === 'system'
}

export function extractSystemPromptSegmentsFromVendorPayload(
  payload: Record<string, unknown> | null | undefined,
): string[] {
  if (!payload || typeof payload !== 'object') return []
  const segments: string[] = []
  const ins = payload.instructions
  if (typeof ins === 'string' && ins.trim()) segments.push(ins.trim())
  const top = anthropicStyleSystemToText(payload.system).trim()
  if (top) segments.push(top)
  const messages = payload.messages
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      const body = unwrapStoredMessage(msg)
      if (!body) continue
      if (!isSystemLikeMessage(msg, body)) continue
      const piece = messageContentToPlainText(body.content).trim()
      if (piece) segments.push(piece)
    }
  }
  return dedupeIdenticalSystemSegments(segments)
}

function formatSystemPromptFullText(segments: string[]): string {
  const list = segments.filter((s) => String(s || '').trim())
  if (!list.length) return ''
  if (list.length === 1) return list[0]
  const parts = [list[0]]
  for (let i = 1; i < list.length; i += 1) {
    parts.push(`──────── system segment ${i + 1}/${list.length} ────────\n\n${list[i]}`)
  }
  return parts.join('\n\n')
}

function extractFirstUserMessageAsInstruction(payload: Record<string, unknown>): string {
  const messages = payload.messages
  if (!Array.isArray(messages)) return ''
  for (const msg of messages) {
    const body = unwrapStoredMessage(msg)
    if (!body) continue
    if (messageRole(msg) !== 'user') continue
    const text = messageContentToPlainText(body.content).trim()
    if (text) return text
    break
  }
  return ''
}

function latestUserMessage(payload: Record<string, unknown>): string {
  const messages = payload.messages
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    const body = unwrapStoredMessage(msg)
    if (!body) continue
    if (messageRole(msg) !== 'user') continue
    const name = String(body.name || '').trim()
    if (name === 'conversation_summary') continue
    const text = messageContentToPlainText(body.content)
    if (!text) continue
    return text
  }
  return ''
}

export function resolveVendorRequestFromStored(parsed: unknown): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== 'object') return null
  const wrap = parsed as Record<string, unknown>
  const nested = wrap.vendor_request
  if (nested && typeof nested === 'object') return nested as Record<string, unknown>
  if (
    wrap.messages != null ||
    wrap.model != null ||
    wrap.instructions != null ||
    wrap.system != null ||
    wrap.tools != null ||
    wrap.input != null
  ) {
    return wrap
  }
  const payload = wrap.payload
  if (payload && typeof payload === 'object') {
    const pl = payload as Record<string, unknown>
    if (
      pl.messages != null ||
      pl.model != null ||
      pl.instructions != null ||
      pl.system != null ||
      pl.tools != null ||
      pl.input != null
    ) {
      return pl
    }
  }
  return null
}

/** Extract tool names from vendor request ``tools`` (OpenAI/Anthropic schemas). */
export function toolNamesFromVendorRequest(payload: Record<string, unknown> | null | undefined): string[] {
  if (!payload || typeof payload !== 'object') return []
  const pre = payload.request_tool_names
  if (Array.isArray(pre)) {
    const names = pre.map((n) => String(n).trim()).filter(Boolean)
    if (names.length) return [...new Set(names)]
  }
  const out: string[] = []
  const tools = payload.tools
  if (Array.isArray(tools)) {
    for (const t of tools) {
      if (!t || typeof t !== 'object') continue
      const row = t as Record<string, unknown>
      const fn = row.function
      if (fn && typeof fn === 'object') {
        const name = String((fn as { name?: unknown }).name || '').trim()
        if (name) out.push(name)
        continue
      }
      const name = String(row.name || '').trim()
      if (name) out.push(name)
    }
  }
  if (out.length) return [...new Set(out)]
  const messages = payload.messages
  if (!Array.isArray(messages)) return []
  for (const msg of messages) {
    const body = unwrapStoredMessage(msg)
    if (!body) continue
    const tcs = body.tool_calls
    if (!Array.isArray(tcs)) continue
    for (const tc of tcs) {
      if (!tc || typeof tc !== 'object') continue
      const row = tc as Record<string, unknown>
      const fn = row.function
      const n =
        (fn && typeof fn === 'object' && (fn as { name?: unknown }).name) || row.name
      if (n) out.push(String(n))
    }
  }
  return [...new Set(out)]
}

function normalizeReasoningEffort(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'object' && value !== null && 'effort' in value) {
    return normalizeReasoningEffort((value as { effort?: unknown }).effort)
  }
  const s = String(value).trim().toLowerCase()
  if (!s || s === 'none') return null
  if (s === 'x-high') return 'xhigh'
  return s
}

const BUDGET_BY_EFFORT: Record<string, number> = {
  minimal: 4096,
  low: 8192,
  medium: 16384,
  high: 32768,
  xhigh: 49152,
}

function effortFromBudgetTokens(budget: number): string | null {
  let best: string | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const [effort, ref] of Object.entries(BUDGET_BY_EFFORT)) {
    const dist = Math.abs(budget - ref)
    if (dist < bestDist) {
      bestDist = dist
      best = effort
    }
  }
  return best
}

function inferThinkingFromVendorPayload(vendorRequest: Record<string, unknown> | null): Record<string, unknown> {
  if (!vendorRequest) return {}
  const out: Record<string, unknown> = {}
  let effort = normalizeReasoningEffort(vendorRequest.reasoning_effort)
  const topReasoning = vendorRequest.reasoning
  if (topReasoning && typeof topReasoning === 'object') {
    effort = effort || normalizeReasoningEffort((topReasoning as { effort?: unknown }).effort)
  }
  if (effort) {
    out.reasoning_effort = effort
    out.thinking_enabled = effort !== 'minimal' && effort !== 'none'
  }

  const extra = vendorRequest.extra_body
  if (extra && typeof extra === 'object') {
    const eb = extra as Record<string, unknown>
    const reasoning = eb.reasoning
    if (reasoning && typeof reasoning === 'object') {
      const nestedEffort = normalizeReasoningEffort((reasoning as { effort?: unknown }).effort)
      if (nestedEffort && !out.reasoning_effort) {
        out.reasoning_effort = nestedEffort
        out.thinking_enabled = nestedEffort !== 'minimal' && nestedEffort !== 'none'
      }
    }
    const zhipuEffort = eb.reasoning_effort
    if (zhipuEffort != null && !out.reasoning_effort) {
      const nested = normalizeReasoningEffort(zhipuEffort)
      if (nested) {
        out.reasoning_effort = nested
        out.thinking_enabled = nested !== 'minimal' && nested !== 'none'
      }
    }
    const enableThinking = eb.enable_thinking
    if (enableThinking === true || String(enableThinking).toLowerCase() === 'true') {
      out.thinking_enabled = true
    } else if (enableThinking === false || String(enableThinking).toLowerCase() === 'false') {
      out.thinking_enabled = false
    }
    const thinking = eb.thinking
    if (thinking && typeof thinking === 'object') {
      const typ = String((thinking as { type?: unknown }).type || '').trim().toLowerCase()
      if (typ === 'enabled' || typ === 'auto' || typ === 'on') out.thinking_enabled = true
      else if (typ === 'disabled' || typ === 'off' || typ === 'none') out.thinking_enabled = false
      if (!out.reasoning_effort) {
        const budgetRaw =
          (thinking as { budget_tokens?: unknown }).budget_tokens ??
          (thinking as { budgetTokens?: unknown }).budgetTokens
        const budget = budgetRaw != null ? Number(budgetRaw) : NaN
        if (Number.isFinite(budget) && budget > 0) {
          out.thinking_budget_tokens = budget
          const inferred = effortFromBudgetTokens(budget)
          if (inferred) out.reasoning_effort_inferred = inferred
        }
      }
    }
  }

  const topThinking = vendorRequest.thinking
  if (topThinking && typeof topThinking === 'object') {
    const typ = String((topThinking as { type?: unknown }).type || '').trim().toLowerCase()
    if (typ === 'enabled' || typ === 'auto' || typ === 'on') out.thinking_enabled = true
    else if (typ === 'disabled' || typ === 'off' || typ === 'none') out.thinking_enabled = false
  }

  return out
}

function formatThinkingLabel(ctx: Record<string, unknown>): string {
  const te = ctx.thinking_enabled ?? ctx.thinkingEnabled
  const effort = String(ctx.reasoning_effort || ctx.reasoningEffort || ctx.reasoning_effort_inferred || ctx.reasoningEffortInferred || '').trim()
  const thinkingType = String(ctx.thinking_type || ctx.thinkingType || '').trim().toLowerCase()
  const budgetRaw = ctx.thinking_budget_tokens ?? ctx.thinkingBudgetTokens
  const budget = budgetRaw != null ? Number(budgetRaw) : null
  const explicitEffort = Boolean(String(ctx.reasoning_effort || ctx.reasoningEffort || '').trim())

  if (te === false || effort === 'minimal' || effort === 'none') return '关闭'
  if (thinkingType === 'auto' && te == null && !effort) return '自动'
  const labels: Record<string, string> = {
    minimal: '极低',
    low: '轻度',
    medium: '中度',
    high: '深度',
    xhigh: '极高',
    max: '最高',
  }
  if (effort) {
    const label = labels[effort] || effort
    if (!explicitEffort && budget && Number.isFinite(budget)) return `${label} (${budget} tokens)`
    return label
  }
  if (te === true) {
    return budget && Number.isFinite(budget) ? `开启 (${budget} tokens)` : '开启'
  }
  if (te == null) return '未知'
  return '关闭'
}

function vendorThinkingSnapshot(vendorRequest: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!vendorRequest) return null
  const out: Record<string, unknown> = {}
  if (vendorRequest.reasoning != null) out.reasoning = vendorRequest.reasoning
  if (vendorRequest.reasoning_effort != null) out.reasoning_effort = vendorRequest.reasoning_effort
  const extra = vendorRequest.extra_body
  if (extra && typeof extra === 'object') {
    const eb = extra as Record<string, unknown>
    if (eb.reasoning != null) out.reasoning = eb.reasoning
    if (eb.thinking != null) out.thinking = eb.thinking
    if (eb.enable_thinking != null) out.enable_thinking = eb.enable_thinking
  }
  if (vendorRequest.thinking != null) out.thinking = vendorRequest.thinking
  return Object.keys(out).length ? out : null
}

export function parseThinkingContext(
  raw: unknown,
  detailMeta?: Record<string, unknown> | null,
): ThinkingContextView | null {
  const parsed = parseJsonValue(raw)
  const wrap = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  const eth =
    (wrap?.evoflow_thinking && typeof wrap.evoflow_thinking === 'object'
      ? (wrap.evoflow_thinking as Record<string, unknown>)
      : null) ||
    (detailMeta?.evoflow_thinking && typeof detailMeta.evoflow_thinking === 'object'
      ? (detailMeta.evoflow_thinking as Record<string, unknown>)
      : null)

  const merged: Record<string, unknown> = { ...(eth || {}) }
  if (detailMeta) {
    for (const key of ['thinking_enabled', 'reasoning_effort', 'thinking_type', 'thinking_budget_tokens', 'session_mode', 'thinking_label'] as const) {
      if (detailMeta[key] != null && merged[key] == null) merged[key] = detailMeta[key]
    }
  }

  const vendorRequest = resolveVendorRequestFromStored(parsed)
  const vendorInferred = inferThinkingFromVendorPayload(vendorRequest)
  for (const [key, val] of Object.entries(vendorInferred)) {
    if (merged[key] == null) merged[key] = val
  }
  if (!merged.reasoning_effort && merged.reasoning_effort_inferred) {
    merged.reasoning_effort = merged.reasoning_effort_inferred
  }

  if (!Object.keys(merged).length && !vendorRequest) return null

  const thinkingEnabled =
    merged.thinking_enabled != null
      ? Boolean(Number(merged.thinking_enabled) || merged.thinking_enabled === true)
      : merged.thinkingEnabled != null
        ? Boolean(merged.thinkingEnabled)
        : null

  const ctx: ThinkingContextView = {
    thinkingEnabled,
    reasoningEffort: String(merged.reasoning_effort || merged.reasoningEffort || '').trim() || null,
    reasoningEffortInferred:
      String(merged.reasoning_effort_inferred || merged.reasoningEffortInferred || '').trim() || null,
    thinkingType: String(merged.thinking_type || merged.thinkingType || '').trim() || null,
    thinkingBudgetTokens:
      merged.thinking_budget_tokens != null
        ? Number(merged.thinking_budget_tokens)
        : merged.thinkingBudgetTokens != null
          ? Number(merged.thinkingBudgetTokens)
          : null,
    sessionMode: String(merged.session_mode || merged.sessionMode || '').trim() || null,
    label: String(merged.thinking_label || merged.label || '').trim() || formatThinkingLabel(merged),
    vendorThinking: vendorThinkingSnapshot(
      vendorRequest && typeof vendorRequest === 'object' ? vendorRequest : null,
    ),
  }
  return ctx
}

export function parseRequestViews(raw: unknown): ParsedRequestViews | null {
  const parsed = parseJsonValue(raw)
  if (parsed == null) return null
  const rawText =
    typeof raw === 'string'
      ? raw
      : typeof parsed === 'string'
        ? String(parsed)
        : ''
  const wrap = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  const vendorRequest = resolveVendorRequestFromStored(parsed)

  let systemPrompt = systemPromptFromWrap(wrap)
  if (!systemPrompt && vendorRequest) {
    const segments = extractSystemPromptSegmentsFromVendorPayload(vendorRequest)
    if (segments.length) {
      systemPrompt = formatSystemPromptFullText(segments)
    } else {
      const userFallback = extractFirstUserMessageAsInstruction(vendorRequest)
      if (userFallback) systemPrompt = userFallback
    }
  }
  if (!systemPrompt && rawText) {
    systemPrompt = extractSystemPromptFromJsonText(rawText)
  }

  let userLatest = vendorRequest ? latestUserMessage(vendorRequest) : ''
  if (!userLatest) userLatest = latestUserFromWrap(wrap)

  let requestToolNames = toolNamesFromVendorRequest(vendorRequest)
  if (!requestToolNames.length) requestToolNames = requestToolNamesFromWrap(wrap)
  if (!requestToolNames.length && rawText) {
    requestToolNames = extractToolNamesFromJsonText(rawText)
  }

  let requestToolStats = parseToolContentStats(wrap?.request_tools_stats)
  if (!requestToolStats.length && vendorRequest?.tools) {
    const wireStats = toolStatsFromWireTools(vendorRequest.tools)
    const hasSchema = wireStats.some((row) => row.chars > 40)
    if (hasSchema) requestToolStats = wireStats
  }
  const toolsTotalRaw = wrap?.request_tools_tokens_total
  const requestToolsTokensTotal =
    typeof toolsTotalRaw === 'number' && Number.isFinite(toolsTotalRaw)
      ? Math.round(toolsTotalRaw)
      : requestToolStats.length
        ? requestToolStats.reduce((sum, row) => sum + row.tokens, 0)
        : null

  const systemPromptStats =
    parseContentStats(wrap?.system_prompt_stats) ?? estimateTextStats(systemPrompt)
  const userLatestStats =
    parseContentStats(wrap?.latest_user_stats) ?? estimateTextStats(userLatest)

  return {
    raw: parsed,
    vendorRequest,
    systemPrompt,
    userLatest,
    requestToolNames,
    systemPromptStats,
    userLatestStats,
    requestToolStats,
    requestToolsTokensTotal,
    thinkingContext: parseThinkingContext(parsed, null),
  }
}

function toolNameFromCall(tc: Record<string, unknown>): string {
  const fn = tc.function
  if (fn && typeof fn === 'object') {
    const name = String((fn as { name?: string }).name || '').trim()
    if (name) return name
  }
  return String(tc.name || 'tool').trim() || 'tool'
}

function toolArgsFromCall(tc: Record<string, unknown>): unknown {
  const fn = tc.function
  if (fn && typeof fn === 'object') {
    const args = (fn as { arguments?: unknown }).arguments
    if (typeof args === 'string') {
      try {
        return JSON.parse(args)
      } catch {
        return args
      }
    }
    return args ?? null
  }
  return tc.arguments ?? tc.input ?? null
}

function messageBody(msg: unknown): Record<string, unknown> | null {
  return unwrapStoredMessage(msg)
}

function reasoningFromBody(body: Record<string, unknown>): string {
  const ak = body.additional_kwargs
  if (ak && typeof ak === 'object') {
    const rc = (ak as Record<string, unknown>).reasoning_content
    if (typeof rc === 'string' && rc.trim()) return rc.trim()
  }
  const content = body.content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      if (part && typeof part === 'object') {
        const row = part as Record<string, unknown>
        if (row.type === 'thinking' && typeof row.thinking === 'string' && row.thinking.trim()) {
          parts.push(row.thinking.trim())
        }
      }
    }
    if (parts.length) return parts.join('\n\n')
  }
  return ''
}

function normalizeFinishReason(raw: unknown): string | null {
  if (raw == null) return null
  const text = String(raw).trim()
  if (!text) return null
  const half = Math.floor(text.length / 2)
  if (half > 0 && text.slice(0, half) === text.slice(half)) {
    return text.slice(0, half)
  }
  return text
}

function collectFromMessage(
  msg: unknown,
  contentParts: string[],
  reasoningParts: string[],
  toolCalls: ParsedToolCall[],
) {
  const body = messageBody(msg)
  if (!body) return
  const text = contentToText(body.content)
  if (text) contentParts.push(text)
  const textField = body.text
  if (typeof textField === 'string' && textField.trim()) contentParts.push(textField.trim())
  const reasoning = reasoningFromBody(body)
  if (reasoning) reasoningParts.push(reasoning)

  const toolCallLists = [body.tool_calls]
  const ak = body.additional_kwargs
  if (ak && typeof ak === 'object') {
    toolCallLists.push((ak as Record<string, unknown>).tool_calls)
  }
  for (const tcs of toolCallLists) {
    if (!Array.isArray(tcs)) continue
    for (let i = 0; i < tcs.length; i += 1) {
      const tc = tcs[i]
      if (!tc || typeof tc !== 'object') continue
      const row = tc as Record<string, unknown>
      toolCalls.push({
        id: String(row.id || `tool-${toolCalls.length + 1}`),
        name: toolNameFromCall(row),
        arguments: toolArgsFromCall(row),
        raw: row,
      })
    }
  }
}

export function looksLikeApiError(text: string): boolean {
  const lower = text.toLowerCase()
  const needles = [
    'error',
    'exception',
    'timeout',
    'timed out',
    'failed',
    'invalid',
    'rate limit',
    'unauthorized',
    'forbidden',
    'bad request',
    'traceback',
    'upstream',
    '503',
    '502',
    '500',
    '429',
    '404',
  ]
  if (needles.some((n) => lower.includes(n))) return true
  if (text.length <= 120 && !text.includes('\n') && !text.includes('**') && !text.includes('。')) return true
  return false
}

function buildTruncationNote(
  finishReason: string | null,
  assistantContent: string,
  reasoningContent: string,
  toolCalls: ParsedToolCall[],
): string | null {
  const reason = (finishReason || '').toLowerCase()
  if (!reason.includes('length')) return null
  if (assistantContent.trim() || toolCalls.length > 0) {
    return '输出因 token 上限被截断（finish_reason=length）；正文或工具调用可能不完整。'
  }
  if (reasoningContent.trim()) {
    return (
      '输出 token 已用尽（finish_reason=length），模型在 thinking/reasoning 阶段被截断，' +
      '未产生可见正文或工具调用。建议关闭 thinking、缩短上下文，或换更大输出上限的模型。'
    )
  }
  return '输出因 token 上限被截断（finish_reason=length）。'
}

export function parseResponseViews(raw: unknown): ParsedResponseViews | null {
  const parsed = parseJsonValue(raw)
  if (parsed == null) return null
  if (typeof parsed !== 'object') {
    const text = String(parsed)
    return {
      raw: parsed,
      assistantContent: text,
      reasoningContent: '',
      toolCalls: [],
      errorMessage: null,
      finishReason: null,
      truncationNote: null,
      assistantStats: estimateTextStats(text),
      reasoningStats: null,
    }
  }

  const resp = parsed as Record<string, unknown>
  const contentParts: string[] = []
  const reasoningParts: string[] = []
  const toolCalls: ParsedToolCall[] = []
  let finishReason: string | null = null

  const topAssistant = resp.assistant_preview
  if (typeof topAssistant === 'string' && topAssistant.trim()) {
    contentParts.push(topAssistant.trim())
  }

  let errorMessage: string | null = null
  const err = resp.error
  if (err && err !== false) {
    if (typeof err === 'object' && err !== null) {
      const msg = String((err as { message?: string }).message || (err as { detail?: string }).detail || '').trim()
      const typ = String((err as { type?: string }).type || (err as { code?: string }).code || '').trim()
      errorMessage = msg && typ ? `${typ}: ${msg}` : msg || typ || null
    } else if (typeof err === 'string') {
      const text = err.trim()
      if (text && looksLikeApiError(text)) {
        errorMessage = text
      } else if (text) {
        contentParts.push(text)
      }
    }
  }

  const generations = resp.generations
  if (Array.isArray(generations)) {
    for (const row of generations) {
      const gens = Array.isArray(row) ? row : [row]
      for (const gen of gens) {
        if (!gen || typeof gen !== 'object') continue
        const g = gen as Record<string, unknown>
        if (typeof g.text === 'string' && g.text.trim()) contentParts.push(g.text.trim())
        const gi = g.generation_info
        if (gi && typeof gi === 'object') {
          finishReason = finishReason || normalizeFinishReason((gi as Record<string, unknown>).finish_reason)
        }
        collectFromMessage(g.message, contentParts, reasoningParts, toolCalls)
      }
    }
  }

  const choices = resp.choices
  if (Array.isArray(choices)) {
    for (const ch of choices) {
      if (!ch || typeof ch !== 'object') continue
      const c = ch as Record<string, unknown>
      finishReason = finishReason || normalizeFinishReason(c.finish_reason)
      collectFromMessage(c.message, contentParts, reasoningParts, toolCalls)
      collectFromMessage(c.delta, contentParts, reasoningParts, toolCalls)
    }
  }

  const messages = resp.messages
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      collectFromMessage(msg, contentParts, reasoningParts, toolCalls)
    }
  }

  const assistantContent = [...new Set(contentParts.filter(Boolean))].join('\n\n')
  const reasoningContent = [...new Set(reasoningParts.filter(Boolean))].join('\n\n')
  const truncationNote = buildTruncationNote(finishReason, assistantContent, reasoningContent, toolCalls)

  let finalAssistant = assistantContent
  if (!finalAssistant && typeof raw === 'string') {
    finalAssistant = extractAssistantFromResponseJsonText(raw)
  } else if (!finalAssistant && typeof parsed === 'string') {
    finalAssistant = extractAssistantFromResponseJsonText(String(parsed))
  }

  const assistantStats =
    parseContentStats(resp.assistant_stats) ?? estimateTextStats(finalAssistant)
  const reasoningStats = estimateTextStats(reasoningContent)

  return {
    raw: parsed,
    assistantContent: finalAssistant,
    reasoningContent,
    toolCalls,
    errorMessage,
    finishReason,
    truncationNote,
    assistantStats,
    reasoningStats,
  }
}

export function formatJsonText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') {
    const parsed = parseJsonValue(value)
    if (typeof parsed === 'string') return parsed
    try {
      return JSON.stringify(stripObservabilityDebugNoise(parsed), null, 2)
    } catch {
      return value
    }
  }
  try {
    return JSON.stringify(stripObservabilityDebugNoise(value), null, 2)
  } catch {
    return String(value)
  }
}

/** Keys too large / duplicated for debug JSON panes (system prompt has its own tab). */
const OBS_DEBUG_JSON_OMIT_KEYS = new Set(['system_prompt_full'])

/**
 * Deep-clone JSON for UI display, omitting noisy observability wrap fields.
 * Does not mutate the original detail payload used by parsers.
 */
export function stripObservabilityDebugNoise(value: unknown): unknown {
  if (value == null) return value
  if (Array.isArray(value)) {
    return value.map((item) => stripObservabilityDebugNoise(item))
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (OBS_DEBUG_JSON_OMIT_KEYS.has(k)) continue
      out[k] = stripObservabilityDebugNoise(v)
    }
    return out
  }
  return value
}

export function resolveFailureMessage(
  request: { status: string; failureMessage?: string },
  detail: Record<string, unknown> | null,
  responseViews: ParsedResponseViews | null,
): string | null {
  const dbErr = detail?.error_message
  if (typeof dbErr === 'string' && dbErr.trim()) return dbErr.trim()
  if (responseViews?.errorMessage) return responseViews.errorMessage
  if (request.failureMessage?.trim()) return request.failureMessage.trim()
  return null
}
