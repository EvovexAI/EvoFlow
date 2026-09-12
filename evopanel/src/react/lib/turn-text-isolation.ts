/**
 * 每轮 user 之后 assistant 流式/落库须与上一轮隔离（正文 + 思考），避免 checkpoint 回灌误拼。
 */
import type { DisplayRow, MessageSegment, SubagentStreamTask, TerminalStreamTask } from '../chat-types.js'
import {
  assistantBodiesLooselySame,
  flattenStreamDisplayText,
  normalizeStreamPlainLoose,
  resolveDisplayReasoningSegments,
} from '../../lib/chat-normalize.js'
import { collectStaleToolIdsFromPriorTurn } from './session-runtime-store.js'
import {
  collectToolCallIdsFromTurn,
  filterStaleToolEntries,
  projectStreamTurn,
  streamTurnHasVisibleContent,
  type StreamTurnState,
} from './stream-turn-engine.js'

/** 取更完整的封存段（停后立刻发消息时 stream 往往比已落库 row 更长） */
export function pickRichestTurnStripText(a: string, b: string): string {
  const A = String(a || '').trimEnd()
  const B = String(b || '').trimEnd()
  if (!A) return B
  if (!B) return A
  if (B.startsWith(A) || (A.length >= 12 && B.includes(A))) return B
  if (A.startsWith(B) || (B.length >= 12 && A.includes(B))) return A
  return B.length > A.length ? B : A
}

export type PriorTurnStripBundle = {
  body: string
  reasoning: string
  /** 多段思考分别剥离（joined reasoning 前缀无法匹配单段 replay） */
  reasoningSegments?: string[]
  /** 上一轮 assistant 上的 tool_call_id，防 values 回灌 */
  toolIds: string[]
}

export const EMPTY_PRIOR_TURN_STRIP: PriorTurnStripBundle = {
  body: '',
  reasoning: '',
  reasoningSegments: [],
  toolIds: [],
}

function mergeReasoningSegmentStripLists(a?: string[], b?: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const list of [a || [], b || []]) {
    for (const raw of list) {
      const s = String(raw || '').trim()
      if (!s || seen.has(s)) continue
      seen.add(s)
      out.push(s)
    }
  }
  return out
}

function priorReasoningStripParts(bundle: PriorTurnStripBundle): string[] {
  const fromArr = Array.isArray(bundle.reasoningSegments)
    ? bundle.reasoningSegments.map((s) => String(s || '').trim()).filter(Boolean)
    : []
  if (fromArr.length) return fromArr
  const joined = String(bundle.reasoning || '').trim()
  if (!joined) return []
  const split = joined.split(/\n\n+/).map((s) => s.trim()).filter(Boolean)
  return split.length ? split : [joined]
}

export function assistantPlainForTurnStrip(row: DisplayRow | undefined): string {
  if (!row || row.role !== 'assistant') return ''
  const segs = row.segments
  if (segs && segs.length) {
    const fromSegs = flattenStreamDisplayText(segs, '').trimEnd()
    if (fromSegs) return fromSegs
  }
  return String(row.text || '').trimEnd()
}

export function assistantReasoningPlainForTurnStrip(row: DisplayRow | undefined): string {
  if (!row || row.role !== 'assistant') return ''
  const segs = resolveDisplayReasoningSegments(row)
  if (segs.length) return segs.join('\n\n').trimEnd()
  return String(row.reasoningPreview || '').trimEnd()
}

/** 最后一条 user 之后、本轮内的 assistant（若有） */
export function findAssistantRowAfterLastUser(rows: DisplayRow[]): DisplayRow | undefined {
  let lastUserIdx = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]?.role === 'user') {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx < 0) return undefined
  for (let i = rows.length - 1; i > lastUserIdx; i--) {
    if (rows[i]?.role === 'assistant') return rows[i]
  }
  return undefined
}

/** 末尾 user 之前最近一条 assistant（跳过 system 等） */
export function findAssistantRowBeforeTrailingUser(rows: DisplayRow[]): DisplayRow | undefined {
  let pastUser = false
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (!pastUser && row.role === 'user') {
      pastUser = true
      continue
    }
    if (pastUser && row.role === 'system') continue
    if (pastUser && row.role === 'assistant') return row
    if (pastUser) break
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role === 'assistant') return rows[i]
  }
  return undefined
}

/** 发送后：取「当前 user 之前」assistant 正文前缀 */
export function assistantStripPrefixFromRows(rows: DisplayRow[]): string {
  return assistantPlainForTurnStrip(findAssistantRowBeforeTrailingUser(rows))
}

/** 发送后：正文 + 思考 + 工具 id 前缀（供本轮流式/落库剥离） */
export function priorTurnStripBundleFromRows(rows: DisplayRow[]): PriorTurnStripBundle {
  const row = findAssistantRowBeforeTrailingUser(rows)
  const reasoningSegments = row ? resolveDisplayReasoningSegments(row) : []
  return {
    body: assistantPlainForTurnStrip(row),
    reasoning: reasoningSegments.length
      ? reasoningSegments.join('\n\n').trimEnd()
      : assistantReasoningPlainForTurnStrip(row),
    reasoningSegments,
    toolIds: collectStaleToolIdsFromPriorTurn(rows),
  }
}

/** 发送前：把仍在流里、尚未落库的工具也标记为 stale */
/** 流式 reasoning 分片可能在 CJK 字符间插入空格，合并为可读文本（与 ws-client 一致） */
export function fixReasoningStreamText(text: string): string {
  const s = String(text || '')
  if (!s) return ''
  return s.replace(
    /([\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])\s+(?=[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/g,
    '$1',
  )
}

/** 从仍在内存中的 stream turn 提取正文/思考前缀（停止后立刻再发时 stream 可能已被清空） */
export function priorTurnStripFromStreamTurn(
  turn: StreamTurnState,
): Pick<PriorTurnStripBundle, 'body' | 'reasoning' | 'reasoningSegments'> {
  const proj = projectStreamTurn(turn)
  const body = flattenStreamDisplayText(proj.segments, proj.text).trimEnd()
  const reasoningSegments = proj.reasoningSegments
    .map((s) => String(s || '').trim())
    .filter(Boolean)
  const reasoning = reasoningSegments.length
    ? reasoningSegments.join('\n\n').trimEnd()
    : String(proj.reasoningPreview || '').trimEnd()
  return { body, reasoning, reasoningSegments }
}

export function mergePriorTurnStripBundles(
  a: PriorTurnStripBundle,
  b: PriorTurnStripBundle,
): PriorTurnStripBundle {
  const reasoningSegments = mergeReasoningSegmentStripLists(
    a.reasoningSegments,
    b.reasoningSegments,
  )
  const reasoning = reasoningSegments.length
    ? reasoningSegments.join('\n\n').trimEnd()
    : pickRichestTurnStripText(a.reasoning, b.reasoning)
  return {
    body: pickRichestTurnStripText(a.body, b.body),
    reasoning,
    reasoningSegments,
    toolIds: [...new Set([...(a.toolIds || []), ...(b.toolIds || [])])],
  }
}

/** 用户停止 / 封存 partial turn 时写入 runtime，供下一轮流式剥离 checkpoint 回灌 */
export function commitPriorTurnStripFromStreamTurn(
  rt: { priorTurnStrip: PriorTurnStripBundle },
  turn: StreamTurnState,
): void {
  if (!streamTurnHasVisibleContent(turn)) return
  const fromTurn = priorTurnStripFromStreamTurn(turn)
  rt.priorTurnStrip = mergePriorTurnStripBundles(rt.priorTurnStrip, {
    ...fromTurn,
    toolIds: collectToolCallIdsFromTurn(turn),
  })
}

/** 同轮内存释放：只剥离正文/思考回灌，不把已封存工具 id 标为 prior 污染 */
export function commitPriorTurnStripTextFromStreamTurn(
  rt: { priorTurnStrip: PriorTurnStripBundle },
  turn: StreamTurnState,
): void {
  if (!streamTurnHasVisibleContent(turn)) return
  const fromTurn = priorTurnStripFromStreamTurn(turn)
  rt.priorTurnStrip = mergePriorTurnStripBundles(rt.priorTurnStrip, {
    body: fromTurn.body,
    reasoning: fromTurn.reasoning,
    toolIds: [],
  })
}

export function priorTurnStripBundleWithStream(
  rows: DisplayRow[],
  streamTurn: StreamTurnState,
): PriorTurnStripBundle {
  const base = priorTurnStripBundleFromRows(rows)
  const fromTurn = priorTurnStripFromStreamTurn(streamTurn)
  const fromStream = collectToolCallIdsFromTurn(streamTurn)
  const toolIds = fromStream.length
    ? [...new Set([...base.toolIds, ...fromStream])]
    : base.toolIds
  return {
    body: pickRichestTurnStripText(base.body, fromTurn.body),
    reasoning: pickRichestTurnStripText(base.reasoning, fromTurn.reasoning),
    toolIds,
  }
}

export function normalizePriorTurnStripBundle(
  input: string | PriorTurnStripBundle | null | undefined,
): PriorTurnStripBundle {
  if (!input) return EMPTY_PRIOR_TURN_STRIP
  if (typeof input === 'string') return { body: input, reasoning: '', reasoningSegments: [], toolIds: [] }
  const reasoningSegments = Array.isArray(input.reasoningSegments)
    ? input.reasoningSegments.map((s) => String(s || '').trim()).filter(Boolean)
    : []
  const reasoning = reasoningSegments.length
    ? reasoningSegments.join('\n\n').trimEnd()
    : String(input.reasoning || '')
  return {
    body: String(input.body || ''),
    reasoning,
    reasoningSegments,
    toolIds: Array.isArray(input.toolIds) ? [...input.toolIds] : [],
  }
}

/** 强制剥离单段前缀（无最短长度限制） */
export function stripPriorTurnAssistantText(incoming: string, prefix: string): string {
  const p = String(prefix || '').trimEnd()
  const inc = String(incoming || '')
  if (!p || !inc) return inc
  if (inc.startsWith(p)) {
    return inc.slice(p.length).replace(/^[\s\n\r]+/, '')
  }
  return inc
}

function orderedBodyStripCandidates(bundle: PriorTurnStripBundle): string[] {
  const body = String(bundle.body || '').trimEnd()
  const reasoning = String(bundle.reasoning || '').trimEnd()
  const out: string[] = []
  if (reasoning && body) {
    out.push(reasoning + body)
    out.push(`${reasoning}\n\n${body}`)
    out.push(`${reasoning}\n${body}`)
  }
  if (body) out.push(body)
  if (reasoning) out.push(reasoning)
  return out
}

const MIN_EMBEDDED_DUPLICATE_LEN = 48

/** 新正文中间/末尾重复上一轮封存段（停后继续常见） */
function stripEmbeddedPriorBodyDuplicate(out: string, body: string): string {
  const b = String(body || '').trim()
  const s = String(out || '')
  if (!b || b.length < MIN_EMBEDDED_DUPLICATE_LEN || !s) return s
  const idx = s.indexOf(b)
  if (idx <= 0) return s
  return (s.slice(0, idx) + s.slice(idx + b.length)).replace(/\n{3,}/g, '\n\n').trim()
}

function stripTrailingPriorBodySuffix(out: string, body: string): string {
  const b = String(body || '').trim()
  let s = String(out || '')
  if (!b || b.length < 12 || !s) return s
  const minOverlap = Math.min(24, Math.max(10, Math.floor(b.length * 0.1)))
  for (let guard = 0; guard < 4; guard++) {
    if (s.endsWith(b)) {
      s = s.slice(0, -b.length).replace(/[\s\n\r]+$/, '')
      continue
    }
    const maxLen = Math.min(s.length, b.length, 240)
    let removed = false
    for (let len = maxLen; len >= minOverlap; len--) {
      const tail = s.slice(-len)
      const head = b.slice(0, len)
      if (tail === head || (b.includes(tail) && b.indexOf(tail) <= 4)) {
        s = s.slice(0, -len).replace(/[\s\n\r]+$/, '')
        removed = true
        break
      }
    }
    if (removed) continue
    break
  }
  return s
}

/** 从正文 delta/final 剥离上一轮思考 + 正文误拼前缀/重复段 */
export function stripPriorTurnPollutants(
  incoming: string,
  bundle: PriorTurnStripBundle,
): string {
  let out = String(incoming || '')
  if (!out) return out
  for (const prefix of orderedBodyStripCandidates(bundle)) {
    out = stripPriorTurnAssistantText(out, prefix)
  }
  const body = String(bundle.body || '').trim()
  if (body) {
    out = stripEmbeddedPriorBodyDuplicate(out, body)
    out = stripTrailingPriorBodySuffix(out, body)
  }
  return out
}

/** 从思考流剥离上一轮思考前缀 */
export function stripPriorTurnReasoningFromStream(
  incoming: string,
  bundle: PriorTurnStripBundle,
): string {
  const raw = String(incoming || '')
  const prefix = String(bundle.reasoning || '').trimEnd()
  if (!prefix || !raw) return raw
  const direct = stripPriorTurnAssistantText(raw, prefix)
  if (direct !== raw) return direct
  const np = fixReasoningStreamText(prefix)
  const nr = fixReasoningStreamText(raw)
  if (np && nr.startsWith(np) && nr.length > np.length) {
    return nr.slice(np.length).replace(/^[\s\n\r]+/, '')
  }
  return raw
}

function compactWhitespace(s: string): string {
  return String(s || '').replace(/\s+/g, '')
}

/** 宽松去重：checkpoint 回灌的正文与已落库 assistant 仅空白/换行差异时视为重复 */
export function stripLoosePriorBodyEcho(text: string, priorBody: string): string {
  const body = String(priorBody || '').trim()
  const out = String(text || '')
  if (!body || !out) return out
  if (assistantBodiesLooselySame(out, body)) return ''
  const on = normalizeStreamPlainLoose(out)
  const bn = normalizeStreamPlainLoose(body)
  if (!bn) return out
  if (on === bn) return ''
  if (on.startsWith(bn)) return on.slice(bn.length).replace(/^[\s\n]+/, '')
  const oc = compactWhitespace(out)
  const bc = compactWhitespace(body)
  if (!bc) return out
  if (oc === bc) return ''
  if (oc.startsWith(bc)) {
    const suffixCompact = oc.slice(bc.length)
    if (!suffixCompact) return ''
    for (let start = 0; start <= out.length; start++) {
      const tail = out.slice(start)
      if (compactWhitespace(tail) === suffixCompact) {
        return tail.replace(/^[\s\n]+/, '')
      }
    }
  }
  return out
}

/** 思考流：上一轮 reasoning 被整段 replay 时的宽松剥离 */
export function stripLoosePriorReasoningEcho(text: string, priorReasoning: string): string {
  const prefix = String(priorReasoning || '').trim()
  const out = String(text || '')
  if (!prefix || !out) return out
  if (assistantBodiesLooselySame(out, prefix)) return ''
  const on = fixReasoningStreamText(out)
  const pn = fixReasoningStreamText(prefix)
  if (!pn) return out
  if (on === pn) return ''
  if (on.startsWith(pn) && on.length > pn.length) {
    return on.slice(pn.length).replace(/^[\s\n]+/, '')
  }
  return out
}

function pruneEmptyTimelineSegments(segments: MessageSegment[]): MessageSegment[] {
  return segments.filter((s) => {
    if (s.kind === 'text' || s.kind === 'reasoning') return !!String(s.text || '').trim()
    return true
  })
}

function stripTextSegmentList(segments: MessageSegment[], bundle: PriorTurnStripBundle): MessageSegment[] {
  if (!bundle.body && !bundle.reasoning) return segments
  return pruneEmptyTimelineSegments(
    segments.map((seg) => {
      if (seg.kind === 'text') {
        let stripped = stripPriorTurnPollutants(String(seg.text || ''), bundle)
        stripped = stripLoosePriorBodyEcho(stripped, bundle.body)
        return stripped === seg.text ? seg : { kind: 'text' as const, text: stripped }
      }
      if (seg.kind === 'reasoning') {
        let stripped = stripPriorTurnReasoningFromStream(String(seg.text || ''), bundle)
        stripped = stripLoosePriorReasoningEcho(stripped, bundle.reasoning)
        return stripped === seg.text ? seg : { kind: 'reasoning' as const, text: stripped }
      }
      return seg
    }),
  )
}

export function filterStaleToolTimelineSegments(
  segments: MessageSegment[],
  staleIds: readonly string[],
): MessageSegment[] {
  if (!staleIds.length) return segments
  const blocked = new Set(staleIds.map((x) => String(x || '').trim()).filter(Boolean))
  if (!blocked.size) return segments
  // @ts-ignore
  return segments.flatMap((seg) => {
    if (seg.kind !== 'tools') return [seg]
    const ids = seg.ids.filter((id) => !blocked.has(String(id || '').trim()))
    if (!ids.length) return []
    return [{ ...seg, ids }]
  })
}

export function collectToolCallIdsFromToolList(tools: unknown[]): Set<string> {
  const ids = new Set<string>()
  for (const t of tools || []) {
    const o = t as Record<string, unknown>
    const id = String(o.id || o.tool_call_id || '').trim()
    if (id) ids.add(id)
  }
  return ids
}

/** 侧栏 thread_state.reasoningPreview 与聊天气泡同源剥离 */
export function stripThreadPanelReasoningPreview(
  preview: string | null | undefined,
  bundle: PriorTurnStripBundle,
): string | null {
  const cleaned = stripPriorTurnReasoningFromStream(String(preview || ''), bundle)
  return String(cleaned || '').trim() ? cleaned : null
}

function projectionHasLiveAssistantContent(opts: {
  text: string
  segments: MessageSegment[]
  reasoningSegments: string[]
  reasoningPreview: string | null
  tools: unknown[]
}): boolean {
  if (flattenStreamDisplayText(opts.segments, opts.text).trim()) return true
  if (opts.reasoningSegments.some((s) => String(s || '').trim())) return true
  if (String(opts.reasoningPreview || '').trim()) return true
  if ((opts.tools || []).length) return true
  return false
}

/** 仅保留仍在本轮工具表内的 terminal 流（防 checkpoint 回灌上一轮命令输出） */
export function filterTerminalStreamsForToolIds(
  streams: Record<string, TerminalStreamTask> | undefined,
  allowedIds: ReadonlySet<string>,
): Record<string, TerminalStreamTask> | undefined {
  if (!streams || !Object.keys(streams).length || !allowedIds.size) return undefined
  const out: Record<string, TerminalStreamTask> = {}
  for (const [k, v] of Object.entries(streams)) {
    const id = String(v?.toolCallId || k || '').trim()
    if (id && allowedIds.has(id)) out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

/** 子代理 task_id 通常与委派 tool_call_id 对齐 */
export function filterSubagentTasksForToolIds(
  tasks: Record<string, SubagentStreamTask> | undefined,
  allowedIds: ReadonlySet<string>,
): Record<string, SubagentStreamTask> | undefined {
  if (!tasks || !Object.keys(tasks).length || !allowedIds.size) return undefined
  const out: Record<string, SubagentStreamTask> = {}
  for (const [k, v] of Object.entries(tasks)) {
    const taskId = String(v?.taskId || k || '').trim()
    if ((taskId && allowedIds.has(taskId)) || (k && allowedIds.has(k))) {
      out[k] = v
    }
  }
  return Object.keys(out).length ? out : undefined
}

/** 新 user 消息后：把上一轮 assistant 已交付文件记入 seen，避免 thread_state 累积 artifacts 再次注入 */
export function seedSeenArtifactPathsFromRows(
  seen: Set<string>,
  rows: DisplayRow[],
): void {
  const prior = findAssistantRowBeforeTrailingUser(rows)
  for (const f of prior?.files || []) {
    const o = f as Record<string, unknown>
    for (const raw of [o.url, o.path, o.name]) {
      const s = String(raw || '').trim()
      if (s) seen.add(s)
    }
  }
}

/** 思考流末尾若已出现当前正文前缀（并行流式常见），裁掉重复草稿 */
export function trimReasoningTextAgainstBody(reasoning: string, body: string): string {
  const rt = String(reasoning || '').trim()
  const tail = String(body || '').replace(/<\/?think(?:ing)?>/gi, '').trim()
  if (!rt || !tail || tail.length < 12) return rt

  if (rt.includes(tail)) {
    const idx = rt.indexOf(tail)
    if (idx > 0) {
      const kept = rt.slice(0, idx).trim()
      if (kept) return kept
    }
    if (idx === 0) return ''
  }

  const probe = tail.slice(0, Math.min(96, tail.length))
  const probeIdx = rt.indexOf(probe)
  if (probeIdx >= 0) {
    const kept = rt.slice(0, probeIdx).trim()
    if (kept) return kept
    if (probeIdx === 0) return ''
  }
  if (tail.length > 80 && rt.includes(tail.slice(0, 80))) {
    const bodyStart = rt.indexOf(tail.slice(0, 80))
    if (bodyStart >= 0) {
      const kept = rt.slice(0, bodyStart).trim()
      if (kept) return kept
      if (bodyStart === 0) return ''
    }
  }
  const on = normalizeStreamPlainLoose(rt)
  const bn = normalizeStreamPlainLoose(tail)
  if (bn.length >= 12 && on.includes(bn)) {
    const start = on.indexOf(bn)
    if (start > 0) {
      for (let i = 0; i <= rt.length; i++) {
        if (normalizeStreamPlainLoose(rt.slice(i)) === on.slice(start)) {
          const kept = rt.slice(0, i).trim()
          if (kept) return kept
          break
        }
      }
    }
  }
  return rt
}

function stripOneReasoningPart(raw: string, part: string): string {
  const p = String(part || '').trim()
  const inc = String(raw || '')
  if (!p || !inc) return inc
  if (assistantBodiesLooselySame(inc, p)) return ''
  let out = stripPriorTurnAssistantText(inc, p)
  if (out !== inc) return out
  out = stripLoosePriorReasoningEcho(inc, p)
  if (out !== inc) return out
  const np = fixReasoningStreamText(p)
  const nr = fixReasoningStreamText(inc)
  if (np && nr.startsWith(np) && nr.length > np.length) {
    return nr.slice(np.length).replace(/^[\s\n\r]+/, '')
  }
  return inc
}

function stripOneReasoningForLiveDisplay(
  raw: string,
  bundle: PriorTurnStripBundle,
  bodyPlain: string,
): string {
  let out = fixReasoningStreamText(String(raw || ''))
  if (bundle.body || bundle.reasoning || bundle.reasoningSegments?.length) {
    for (const part of priorReasoningStripParts(bundle)) {
      out = stripOneReasoningPart(out, part)
      if (!String(out || '').trim()) break
    }
    out = stripPriorTurnReasoningFromStream(out, bundle)
    out = stripLoosePriorReasoningEcho(out, bundle.reasoning)
    out = stripPriorTurnPollutants(out, bundle)
    out = stripLoosePriorBodyEcho(out, bundle.body)
    const priorBody = String(bundle.body || '').trim()
    if (priorBody.length >= 8) {
      for (let guard = 0; guard < 4; guard++) {
        const idx = out.indexOf(priorBody)
        if (idx <= 0) break
        out = (out.slice(0, idx) + out.slice(idx + priorBody.length))
          .replace(/\n{3,}/g, '\n\n')
          .trim()
      }
    }
  }
  if (bodyPlain.length >= 12) {
    out = trimReasoningTextAgainstBody(out, bodyPlain)
  }
  return String(out || '').trim()
}

/** 流式 _stream 气泡：剥离上一轮回灌 + 思考/正文同轮重复 */
export function sanitizeLiveStreamDisplayFields(
  fields: {
    text: string
    reasoningPreview: string | null
    reasoningSegments: string[]
  },
  stripInput: string | PriorTurnStripBundle | null | undefined,
): {
  text: string
  reasoningPreview: string | null
  reasoningSegments: string[]
} {
  const bundle = normalizePriorTurnStripBundle(stripInput)
  let text = String(fields.text || '')
  if (bundle.body || bundle.reasoning) {
    text = stripPriorTurnPollutants(text, bundle)
    text = stripLoosePriorBodyEcho(text, bundle.body)
  }
  const bodyPlain = String(text || '').trim()
  let reasoningPreview = fields.reasoningPreview
  let reasoningSegments = [...(fields.reasoningSegments || [])]
  const stripR = (s: string) => stripOneReasoningForLiveDisplay(s, bundle, bodyPlain)
  if (reasoningPreview) {
    const cleaned = stripR(reasoningPreview)
    reasoningPreview = cleaned || null
  }
  reasoningSegments = reasoningSegments.map(stripR).filter(Boolean)
  if (!reasoningPreview && reasoningSegments.length) {
    reasoningPreview = reasoningSegments[reasoningSegments.length - 1]
  }
  return { text, reasoningPreview, reasoningSegments }
}

/** final / partial 落库：剥离 checkpoint 回灌的上一轮思考与正文 */
export function sanitizeFinalizedTurnForPersist<
  T extends {
    segments?: MessageSegment[]
    text: string
    reasoningSegments: string[]
    reasoningPreview: string | null
  },
>(fin: T, stripInput: string | PriorTurnStripBundle | null | undefined): T {
  const bundle = normalizePriorTurnStripBundle(stripInput)
  const hasStrip = !!(
    bundle.body ||
    bundle.reasoning ||
    bundle.reasoningSegments?.length ||
    bundle.toolIds?.length
  )
  if (!hasStrip) return fin

  const fields = sanitizeLiveStreamDisplayFields(
    {
      text: fin.text,
      reasoningPreview: fin.reasoningPreview,
      reasoningSegments: fin.reasoningSegments,
    },
    bundle,
  )

  let segments = fin.segments
  if (segments?.length) {
    segments = filterStaleToolTimelineSegments(segments, bundle.toolIds)
    segments = stripTextSegmentList(segments, bundle)
    segments = pruneEmptyTimelineSegments(segments)
    if (!segments.length) segments = undefined
  }

  let textOut = fields.text
  if (segments?.some((s) => s.kind === 'text') && String(textOut || '').trim()) {
    const segPlain = flattenStreamDisplayText(segments, '').trim()
    if (segPlain && assistantBodiesLooselySame(segPlain, textOut)) {
      textOut = ''
    }
  }

  return {
    ...fin,
    text: textOut,
    reasoningPreview: fields.reasoningPreview,
    reasoningSegments: fields.reasoningSegments,
    segments,
  }
}

/** DB 历史回放：每条 assistant 剥离其前一轮 user 之前 assistant 的回灌正文/思考 */
export function sanitizeHistoryRowsForTurnIsolation(rows: DisplayRow[]): DisplayRow[] {
  if (!Array.isArray(rows) || !rows.length) return rows
  return rows.map((row, i) => {
    if (row.role !== 'assistant') return row
    let lastUserIdx = -1
    for (let j = i - 1; j >= 0; j--) {
      if (rows[j]?.role === 'user') {
        lastUserIdx = j
        break
      }
    }
    if (lastUserIdx < 0) return row
    const bundle = priorTurnStripBundleFromRows(rows.slice(0, lastUserIdx + 1))
    if (
      !bundle.body &&
      !bundle.reasoning &&
      !(bundle.reasoningSegments?.length)
    ) {
      return row
    }
    const reasoningSegments = row.reasoningSegments?.length
      ? [...row.reasoningSegments]
      : resolveDisplayReasoningSegments(row)
    const sanitized = sanitizeFinalizedTurnForPersist(
      {
        segments: row.segments?.map((s) => ({ ...s })),
        text: row.text || '',
        reasoningSegments,
        reasoningPreview: row.reasoningPreview ?? null,
      },
      bundle,
    )
    const hasVisible =
      String(sanitized.text || '').trim() ||
      (sanitized.segments?.length ?? 0) > 0 ||
      sanitized.reasoningSegments.some((s: string) => String(s || '').trim()) ||
      (row.tools?.length ?? 0) > 0
    if (!hasVisible) return row
    let textOut = sanitized.text
    if (!String(textOut || '').trim() && sanitized.segments?.length) {
      textOut = flattenStreamDisplayText(sanitized.segments, '').trim()
    }
    return {
      ...row,
      text: textOut,
      segments: sanitized.segments,
      ...(sanitized.reasoningSegments.length
        ? {
            reasoningSegments: sanitized.reasoningSegments,
            reasoningPreview: sanitized.reasoningPreview ?? undefined,
          }
        : {
            reasoningSegments: undefined,
            reasoningPreview: sanitized.reasoningPreview ?? undefined,
          }),
    }
  })
}

/** 流式气泡展示：剥离误带入的上一轮思考/正文/工具 */
export function isolateStreamProjection(
  state: StreamTurnState,
  stripInput: string | PriorTurnStripBundle,
) {
  const bundle = normalizePriorTurnStripBundle(stripInput)
  const p = projectStreamTurn(state)
  const staleToolIds = bundle.toolIds
  const cleanTools = filterStaleToolEntries(p.tools, staleToolIds) as unknown[]
  const cleanSegmentsBase = filterStaleToolTimelineSegments(p.segments, staleToolIds)
  const hasStrip = !!(bundle.body || bundle.reasoning || staleToolIds.length)

  let cleanOpen = hasStrip
    ? stripLoosePriorBodyEcho(stripPriorTurnPollutants(p.text, bundle), bundle.body)
    : p.text
  let cleanSegments = hasStrip ? stripTextSegmentList(cleanSegmentsBase, bundle) : cleanSegmentsBase
  const cleanReasoningSegments = hasStrip
    ? p.reasoningSegments
        .map((s) => {
          let t = stripPriorTurnReasoningFromStream(s, bundle)
          t = stripLoosePriorReasoningEcho(t, bundle.reasoning)
          return t
        })
        .filter((s) => String(s || '').trim())
    : [...p.reasoningSegments]
  let cleanReasoningPreview = cleanReasoningSegments.length
    ? cleanReasoningSegments.join('\n\n')
    : hasStrip
      ? stripLoosePriorReasoningEcho(
          stripPriorTurnReasoningFromStream(p.reasoningPreview || '', bundle) || '',
          bundle.reasoning,
        ) || null
      : p.reasoningPreview
  if (cleanReasoningPreview && !String(cleanReasoningPreview).trim()) {
    cleanReasoningPreview = null
  }

  // 整段 replay 仍与上一轮正文相同：只保留剥离后的净增部分
  if (hasStrip && bundle.body) {
    const flatRaw = flattenStreamDisplayText(cleanSegments, cleanOpen)
    const flat = stripLoosePriorBodyEcho(flatRaw, bundle.body)
    if (!String(flat || '').trim()) {
      cleanOpen = ''
      cleanSegments = cleanSegments.filter((s) => s.kind !== 'text')
    } else if (flat !== flatRaw) {
      cleanOpen = flat
      cleanSegments = cleanSegments.filter((s) => s.kind !== 'text')
    }
  }

  const hasLive = projectionHasLiveAssistantContent({
    text: cleanOpen,
    segments: cleanSegments,
    // @ts-ignore
    reasoningSegments: cleanReasoningSegments,
    reasoningPreview: cleanReasoningPreview,
    tools: cleanTools,
  })

  const emptyMedia = { images: [] as unknown[], videos: [] as unknown[], audios: [] as unknown[], files: [] as unknown[] }
  const cleanMedia = hasLive
    ? { images: p.images, videos: p.videos, audios: p.audios, files: p.files }
    : emptyMedia
  const cleanSystemActivity = hasLive ? p.systemActivity : null

  if (!hasStrip) {
    if (
      !hasLive &&
      (p.images.length || p.videos.length || p.audios.length || p.files.length || p.systemActivity)
    ) {
      return { ...p, ...emptyMedia, systemActivity: null }
    }
    return p
  }

  const flatBefore = flattenStreamDisplayText(p.segments, p.text)
  const flatAfter = flattenStreamDisplayText(cleanSegments, cleanOpen)
  const toolsChanged = cleanTools.length !== p.tools.length
  const mediaChanged =
    cleanMedia.images !== p.images ||
    cleanMedia.videos !== p.videos ||
    cleanMedia.audios !== p.audios ||
    cleanMedia.files !== p.files
  const activityChanged = cleanSystemActivity !== p.systemActivity

  if (
    flatBefore === flatAfter &&
    cleanOpen === p.text &&
    cleanReasoningPreview === p.reasoningPreview &&
    !toolsChanged &&
    !mediaChanged &&
    !activityChanged
  ) {
    return p
  }

  return {
    ...p,
    text: cleanOpen,
    segments: cleanSegments,
    tools: cleanTools,
    reasoningSegments: cleanReasoningSegments,
    reasoningPreview: cleanReasoningPreview,
    ...cleanMedia,
    systemActivity: cleanSystemActivity,
  }
}