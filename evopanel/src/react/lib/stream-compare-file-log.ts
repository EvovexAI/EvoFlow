/**
 * 流式对比日志（默认关闭，按会话 + 轮次分目录）：
 *
 *   ~/.evoflow/logs/stream-compare/{sessionKey}/{runId}/sse-recv.log   — 每行一条 SSE data JSON
 *   ~/.evoflow/logs/stream-compare/{sessionKey}/{runId}/ui-display.log — 该轮 UI 展示快照
 *
 * 每轮 RUN_STARTED 写入 `======== TURN n | run=... ========` 分隔头。
 *
 * 开启（浏览器控制台执行一次即可，刷新后仍生效）：
 *   localStorage.setItem('EVOFLOW_STREAM_COMPARE_LOG', '1')
 * 关闭：
 *   localStorage.removeItem('EVOFLOW_STREAM_COMPARE_LOG')
 *
 * Tauri 桌面端落盘路径示例：
 *   ~/.evoflow/logs/stream-compare/{sessionKey}/{runId}/sse-recv.log
 *   ~/.evoflow/logs/stream-compare/{sessionKey}/{runId}/ui-display.log
 *
 * ui-display.log 含 [timeline]、[chunks/layout]、[agui-order]、[compacted] 等段，便于排查工具/思考顺序。
 */
import type { DisplayRow } from '../chat-types.js'
import type { AssistantBubbleDisplayPlan } from './message-row-display-plan.js'
import type { SegmentDisplayChunk } from './exploring-activity-group.js'
import type { AgUiTurnState } from './agui-turn-reducer.js'
import type { CompactedStreamPart, MessageSegment } from '../chat-types.js'
import { formatStreamTurnTimelineMirror } from './stream-turn-debug.js'
import { resolveEffectiveToolName, resolveToolKey } from '../../lib/tool-display.js'
import {
  extractPathFromToolInput,
  extractPathFromToolOutput,
  getToolInputObjectFromRow,
  toolOmitFromChatPanel,
  toolOmitFromStreamingChatPanel,
} from '../../lib/chat-normalize.js'
import { filterIdMatchedInList } from './tool-filter-id-resolve.js'

const LS_KEY = 'EVOFLOW_STREAM_COMPARE_LOG'
const MAX_LINE = 48_000
const UI_SNAPSHOT_CLOSE_MS = 48

/** 默认关闭；localStorage='1' / 'true' 时开启 */
export function isStreamCompareFileLogOn(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false
    const v = localStorage.getItem(LS_KEY)
    return v === '1' || v === 'true'
  } catch {
    return false
  }
}

function isTauriDesktop(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      !!(
        (window as Window & { __TAURI__?: { core?: { invoke?: unknown } } }).__TAURI__?.core?.invoke ||
        (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
      )
    )
  } catch {
    return false
  }
}

type CompareChannel = 'sse-recv' | 'ui-display'

type RunBuffers = {
  sseRecv: string[]
  uiDisplay: string[]
  startedAtMs: number
  turnNo: number
}

type SessionBuffers = {
  runs: Record<string, RunBuffers>
  turnCounter: number
  startedAtMs: number
}

type CompareStore = {
  sessions: Record<string, SessionBuffers>
  activeSessionLogId: string
}

type UiSnapshotAcc = {
  parts: string[]
  closeTimer: ReturnType<typeof setTimeout> | null
  sig: string
}

type LogTarget = {
  sessionLogId: string
  runLogId: string
  dedupeKey: string
}

/** 会话 key → 落盘目录名（与 Tauri 侧过滤规则一致） */
export function sanitizeSessionLogId(sessionKey: string): string {
  return String(sessionKey || '')
    .trim()
    .replace(/:/g, '_')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80)
}

function resolveLogSessionId(sessionKey?: string): string {
  return sanitizeSessionLogId(String(sessionKey || activeSessionLogId || '').trim())
}

function ensureStore(): CompareStore {
  const w = window as Window & { __evoflowStreamCompare?: CompareStore & { runs?: Record<string, SessionBuffers>; activeRunId?: string } }
  if (!w.__evoflowStreamCompare) {
    w.__evoflowStreamCompare = { sessions: {}, activeSessionLogId: '' }
  }
  const store = w.__evoflowStreamCompare
  if (!store.sessions && store.runs) {
    store.sessions = store.runs
    store.activeSessionLogId = String(store.activeRunId || '')
  }
  if (!store.sessions) store.sessions = {}
  return store
}

let activeSessionLogId = ''
let activeSessionStartMs = 0
let compareLogBannerShown = false
const activeRunBySession = new Map<string, string>()
const lastSseSigByRun = new Map<string, string>()
const lastUiSigByRun = new Map<string, string>()
const uiSnapshotByRun = new Map<string, UiSnapshotAcc>()

/** runId → 落盘子目录名 */
export function sanitizeRunLogId(runId: string): string {
  return String(runId || '')
    .trim()
    .replace(/:/g, '_')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80)
}

function runSnapshotKey(sessionLogId: string, runLogId: string): string {
  return `${sessionLogId}/${runLogId}`
}

function relMsForRun(sessionLogId: string, runLogId: string): number {
  const runBuf = ensureStore().sessions[sessionLogId]?.runs[runLogId]
  if (runBuf?.startedAtMs) return Date.now() - runBuf.startedAtMs
  const sessBuf = ensureStore().sessions[sessionLogId]
  if (sessBuf?.startedAtMs) return Date.now() - sessBuf.startedAtMs
  if (sessionLogId === activeSessionLogId && activeSessionStartMs) return Date.now() - activeSessionStartMs
  return 0
}

function formatCompareLine(sessionLogId: string, runLogId: string, body: string): string {
  return `+${relMsForRun(sessionLogId, runLogId)}ms ${body}`.trim()
}

function resolveLogTarget(sessionKey?: string, runId?: string): LogTarget | null {
  const sessionLogId = resolveLogSessionId(sessionKey)
  if (!sessionLogId) return null
  const explicit = sanitizeRunLogId(String(runId || '').trim())
  const active = activeRunBySession.get(sessionLogId) || ''
  // RUN_STARTED 后的服务端 run-xxx 优先于 ws 层仍携带的客户端 uuid
  const runLogId = active || explicit || 'pending'
  return {
    sessionLogId,
    runLogId,
    dedupeKey: runSnapshotKey(sessionLogId, runLogId),
  }
}

function oneLine(s: string): string {
  return String(s || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n+/g, '\n')
    .trim()
}

function shrink(s: unknown, max = 8000): string {
  const t = oneLine(String(s ?? ''))
  if (!t) return ''
  if (t.length <= max) return t
  return `${t.slice(0, max)}…(${t.length})`
}

function ensureSessionBuffers(sessionLogId: string): SessionBuffers {
  const store = ensureStore()
  if (!store.sessions[sessionLogId]) {
    store.sessions[sessionLogId] = {
      runs: {},
      turnCounter: 0,
      startedAtMs: Date.now(),
    }
  }
  return store.sessions[sessionLogId]
}

function ensureRunBuffers(sessionLogId: string, runLogId: string, turnNo: number): RunBuffers {
  const sessionBuf = ensureSessionBuffers(sessionLogId)
  if (!sessionBuf.runs[runLogId]) {
    sessionBuf.runs[runLogId] = {
      sseRecv: [],
      uiDisplay: [],
      startedAtMs: Date.now(),
      turnNo,
    }
  }
  return sessionBuf.runs[runLogId]
}

async function appendFileLine(
  sessionLogId: string,
  runLogId: string,
  channel: CompareChannel,
  line: string,
): Promise<void> {
  const sid = String(sessionLogId || '').trim()
  const rid = sanitizeRunLogId(runLogId)
  if (!sid || !rid) return
  const text = String(line || '').slice(0, MAX_LINE)
  if (!text) return
  if (isTauriDesktop()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('append_stream_compare_log', {
        channel,
        sessionKey: sid,
        runId: rid,
        message: text,
      })
    } catch {
      /* best-effort */
    }
    return
  }
  const runBuf = ensureRunBuffers(sid, rid, ensureSessionBuffers(sid).runs[rid]?.turnNo || 0)
  const key = channel === 'sse-recv' ? 'sseRecv' : 'uiDisplay'
  runBuf[key].push(text)
  const tag = channel === 'sse-recv' ? '[sse-recv]' : '[ui-display]'
   
  console.log(tag, `[${sid}/${rid}]`, text)
}

function showEnableBannerOnce(): void {
  if (compareLogBannerShown || !isStreamCompareFileLogOn()) return
  compareLogBannerShown = true
  const home = isTauriDesktop()
    ? '~/.evoflow/logs/stream-compare/{sessionKey}/{runId}/sse-recv.log + ui-display.log'
    : 'window.__evoflowStreamCompare.sessions（非 Tauri）'
   
  console.log(
    `[stream-compare] 已开启，每个会话 2 个文件 → ${home}；关闭：localStorage.removeItem('${LS_KEY}')`,
  )
}

function flushUiSnapshot(sessionLogId: string, runLogId: string): void {
  const sid = String(sessionLogId || '').trim()
  const rid = sanitizeRunLogId(runLogId)
  if (!sid || !rid) return
  const snapKey = runSnapshotKey(sid, rid)
  const acc = uiSnapshotByRun.get(snapKey)
  if (!acc) return
  if (acc.closeTimer) {
    clearTimeout(acc.closeTimer)
    acc.closeTimer = null
  }
  uiSnapshotByRun.delete(snapKey)
  if (!acc.parts.length) return
  if (lastUiSigByRun.get(snapKey) === acc.sig) return
  lastUiSigByRun.set(snapKey, acc.sig)
  const block = ['---', ...acc.parts, '---'].join('\n')
  void appendFileLine(sid, rid, 'ui-display', formatCompareLine(sid, rid, block))
}

function scheduleUiSnapshotClose(sessionLogId: string, runLogId: string): void {
  const sid = String(sessionLogId || '').trim()
  const rid = sanitizeRunLogId(runLogId)
  if (!sid || !rid) return
  const snapKey = runSnapshotKey(sid, rid)
  const acc = uiSnapshotByRun.get(snapKey)
  if (!acc) return
  if (acc.closeTimer) clearTimeout(acc.closeTimer)
  acc.closeTimer = setTimeout(() => flushUiSnapshot(sid, rid), UI_SNAPSHOT_CLOSE_MS)
}

function appendUiSnapshotPart(sessionLogId: string, runLogId: string, section: string, body: string): void {
  const sid = String(sessionLogId || '').trim()
  const rid = sanitizeRunLogId(runLogId)
  if (!sid || !rid) return
  const snapKey = runSnapshotKey(sid, rid)
  let acc = uiSnapshotByRun.get(snapKey)
  if (!acc) {
    acc = { parts: [], closeTimer: null, sig: '' }
    uiSnapshotByRun.set(snapKey, acc)
  }
  const text = String(body || '').trim()
  if (!text) return
  acc.parts.push(`${section}\n${text}`)
  acc.sig = acc.parts.join('\n')
  scheduleUiSnapshotClose(sid, rid)
}

/** 会话开始/切换时调用（chat send / resume attach） */
export function markStreamCompareSession(sessionKey: string): void {
  if (!isStreamCompareFileLogOn()) return
  showEnableBannerOnce()
  const sid = resolveLogSessionId(sessionKey)
  if (!sid) return
  const prev = activeSessionLogId
  if (prev && prev !== sid) {
    const prevRun = activeRunBySession.get(prev)
    if (prevRun) flushUiSnapshot(prev, prevRun)
    activeRunBySession.delete(prev)
  }
  activeSessionLogId = sid
  if (!activeSessionStartMs || prev !== sid) {
    activeSessionStartMs = Date.now()
    ensureSessionBuffers(sid).startedAtMs = activeSessionStartMs
  }
  const store = ensureStore()
  store.activeSessionLogId = sid
}

/** 新一轮 run 开始（send / resume / RUN_STARTED） */
export function markStreamCompareRun(
  sessionKey: string,
  runId: string,
  opts?: { threadId?: string },
): void {
  if (!isStreamCompareFileLogOn()) return
  const sid = resolveLogSessionId(sessionKey)
  const rid = sanitizeRunLogId(runId)
  if (!sid || !rid) return
  const prevRun = activeRunBySession.get(sid)
  if (prevRun && prevRun !== rid) flushUiSnapshot(sid, prevRun)
  if (prevRun === rid) return
  activeRunBySession.set(sid, rid)
  const sessionBuf = ensureSessionBuffers(sid)
  if (!sessionBuf.runs[rid]) {
    sessionBuf.turnCounter += 1
    const turnNo = sessionBuf.turnCounter
    ensureRunBuffers(sid, rid, turnNo)
    const threadId = String(opts?.threadId || '').trim()
    const header = `======== TURN ${turnNo} | run=${rid}${threadId ? ` | thread=${threadId}` : ''} ========`
    void appendFileLine(sid, rid, 'sse-recv', header)
    void appendFileLine(sid, rid, 'ui-display', formatCompareLine(sid, rid, header))
  }
}

function serializeSsePayload(opts: {
  dataRaw?: string
  data?: Record<string, unknown> | null
}): string {
  const raw = String(opts.dataRaw || '').trim()
  if (raw && raw !== '[DONE]') return raw
  if (raw === '[DONE]') return '[DONE]'
  if (opts.data && typeof opts.data === 'object') {
    try {
      return JSON.stringify(opts.data)
    } catch {
      return shrink(opts.data, 4000)
    }
  }
  return '(no-data)'
}

/** WS 层：每帧仅落盘 SSE data JSON（一行一条） */
export function logStreamCompareSseRecv(opts: {
  sessionKey?: string
  runId?: string
  eventName?: string
  dataRaw?: string
  data?: Record<string, unknown> | null
  wire?: 'openai' | 'evf' | 'agui' | 'raw'
}): void {
  if (!isStreamCompareFileLogOn()) return
  const data = opts.data && typeof opts.data === 'object' ? opts.data : null
  if (data?.type === 'RUN_STARTED') {
    const wireRun = String(data.runId || '').trim()
    if (wireRun && opts.sessionKey) {
      markStreamCompareRun(opts.sessionKey, wireRun, {
        threadId: String(data.threadId || '').trim(),
      })
    }
  }
  const target = resolveLogTarget(opts.sessionKey, opts.runId)
  if (!target) return
  ensureSessionBuffers(target.sessionLogId)
  const payload = serializeSsePayload({ dataRaw: opts.dataRaw, data })
  if (!payload || payload === '(no-data)') return
  if (lastSseSigByRun.get(target.dedupeKey) === payload) return
  lastSseSigByRun.set(target.dedupeKey, payload)
  void appendFileLine(target.sessionLogId, target.runLogId, 'sse-recv', payload)
}

function formatSegmentListBrief(segments: MessageSegment[] | undefined, _tools: unknown[]): string {
  if (!segments?.length) return '  (empty)'
  return segments
    .map((seg, i) => {
      if (seg.kind === 'tools') {
        const ids = (seg.ids || []).map((id) => shrink(String(id), 20)).join(', ')
        return `  #${i} tools×${seg.ids?.length || 0} [${ids}]`
      }
      if (seg.kind === 'reasoning') {
        const text = String(seg.text || '').trim()
        return `  #${i} reasoning${text ? ` ${shrink(text, 120)}` : ' (placeholder)'}`
      }
      if (seg.kind === 'text') {
        return `  #${i} text ${shrink(seg.text, 120)}`
      }
      return `  #${i} unknown`
    })
    .join('\n')
}

/** AG-UI order + compatSegments（排查多轮工具合并时对照 ui-display [timeline]） */
export function formatAgUiTurnOrderMirror(agui: AgUiTurnState): string {
  const orderLines = agui.order.map((e, i) => {
    const seqTag = e.seq != null ? ` seq=${e.seq}` : ''
    const blockTag = e.blockId ? ` block=${shrink(e.blockId, 20)}` : ''
    if (e.kind === 'tool') return `  #${i} tool ${shrink(e.toolCallId, 32)}${seqTag}${blockTag}`
    if (e.kind === 'reasoning') return `  #${i} reasoning msg=${shrink(e.messageId, 32)}${seqTag}${blockTag}`
    return `  #${i} text msg=${shrink(e.messageId, 32)}${seqTag}${blockTag}`
  })
  const compat = formatSegmentListBrief(agui.compatSegments, agui.compatTools)
  const sealedTools = agui.sealedToolIds?.size ?? 0
  const sealedMsgs = agui.sealedMessageIds?.size ?? 0
  return [
    `order×${agui.order.length} sealedTools=${sealedTools} sealedMsgs=${sealedMsgs}`,
    orderLines.length ? orderLines.join('\n') : '  (empty order)',
    'compatSegments:',
    compat,
  ].join('\n')
}

function formatCompactedPartsMirror(parts: CompactedStreamPart[] | undefined): string {
  if (!parts?.length) return '  (none)'
  return parts
    .map((part, pi) => {
      const segLines = formatSegmentListBrief(part.segments, part.tools || [])
      const rs = (part.reasoningSegments || []).filter((s) => String(s || '').trim()).length
      return `  part#${pi} segments=${part.segments?.length || 0} tools=${part.tools?.length || 0} reasoningSegs=${rs}\n${segLines}`
    })
    .join('\n\n')
}

/** buildStreamDisplayRow / drain：AG-UI 内部态 + compacted 封存段 */
export function logStreamCompareAgUiInternals(opts: {
  sessionKey?: string
  runId?: string
  aguiTurn?: AgUiTurnState | null
  compactedParts?: CompactedStreamPart[]
  label?: string
}): void {
  if (!isStreamCompareFileLogOn()) return
  const target = resolveLogTarget(opts.sessionKey, opts.runId)
  if (!target) return
  const label = String(opts.label || 'agui-internals').trim()
  const chunks: string[] = []
  if (opts.aguiTurn) chunks.push(formatAgUiTurnOrderMirror(opts.aguiTurn))
  if (opts.compactedParts?.length) {
    chunks.push('compactedParts:\n' + formatCompactedPartsMirror(opts.compactedParts))
  }
  if (!chunks.length) return
  appendUiSnapshotPart(target.sessionLogId, target.runLogId, `[${label}]`, chunks.join('\n\n'))
}

/** drainAgUiCompletedRound 封存瞬间 */
export function logStreamCompareAgUiDrain(opts: {
  sessionKey?: string
  runId?: string
  sealed?: CompactedStreamPart | null
  releasedToolIds?: string[]
}): void {
  if (!isStreamCompareFileLogOn()) return
  const target = resolveLogTarget(opts.sessionKey, opts.runId)
  if (!target) return
  const released = (opts.releasedToolIds || []).map((id) => shrink(id, 24)).join(', ')
  const body = [
    `releasedTools=${released || '-'}`,
    'sealed:',
    opts.sealed?.segments?.length
      ? formatSegmentListBrief(opts.sealed.segments, opts.sealed.tools || [])
      : '  (empty)',
  ].join('\n')
  appendUiSnapshotPart(target.sessionLogId, target.runLogId, '[agui-drain]', body)
}

function formatChunkDetail(chunk: SegmentDisplayChunk, chunkIndex: number): string {
  if (chunk.kind === 'tools-standalone') {
    const ids = (chunk.ids || []).map((id) => shrink(id, 28)).join(', ')
    return `chunk#${chunkIndex} tools-standalone ids=[${ids}]`
  }
  if (chunk.kind === 'activity') {
    const pieces = (chunk.pieces || [])
      .map((p) => {
        if (p.kind === 'tools') return `tools×${p.ids?.length || 0} [${(p.ids || []).join(', ')}]`
        if (p.kind === 'reasoning') return `reasoning: ${shrink(p.text, 500)}`
        if (p.kind === 'text') return `text: ${shrink(p.text, 500)}`
        // @ts-ignore
        return p.kind
      })
      .join('\n  ')
    return `chunk#${chunkIndex} exploring/activity\n  ${pieces}`
  }
  if (chunk.kind === 'text') {
    return `chunk#${chunkIndex} text: ${shrink(chunk.text, 2000)}`
  }
  // @ts-ignore
  return `chunk#${chunkIndex} ${chunk.kind}`
}

function resolveToolById(tools: unknown[], toolCallId: string): Record<string, unknown> | null {
  const tid = String(toolCallId || '').trim()
  if (!tid) return null
  const tail = tid.slice(-8)
  for (const tool of tools) {
    const t = tool as Record<string, unknown>
    const id = String(t.tool_call_id ?? t.id ?? '').trim()
    if (id === tid || id.endsWith(tail) || tid.endsWith(id.slice(-8))) return t
  }
  return null
}

function formatToolRowDetail(toolCallIds: string[], tools: unknown[]): string {
  return toolCallIds
    .map((id) => {
      const t = resolveToolById(tools, id)
      if (!t) return `  ${id} (未匹配)`
      const name = String(resolveEffectiveToolName(t) || '?')
      const st = String(t.status || '-')
      const preview = String(t._aguiArgsPreview || '').trim()
      const args = shrink(t.function && typeof t.function === 'object'
        ? (t.function as Record<string, unknown>).arguments
        : t.arguments ?? t.input, 200)
      return `  ${name} id=${shrink(id, 32)} status=${st}${preview ? ` preview=${preview}` : ''}${args ? ` args=${args}` : ''}`
    })
    .join('\n')
}

/** 与 ui-display.log 相同：页面气泡实际 slot 布局（供控制台对照） */
export function formatAssistantBubblePageSnapshot(
  plan: AssistantBubbleDisplayPlan,
  tools: unknown[],
): string {
  return formatSlotsBySection(plan, tools)
}

function formatSlotsBySection(plan: AssistantBubbleDisplayPlan, tools: unknown[]): string {
  const sections: string[] = []
  const thinking: string[] = []
  const reasoning: string[] = []
  const planLines: string[] = []
  const body: string[] = []
  const toolRows: string[] = []
  const exploring: string[] = []
  const layout = plan.layout
  const chunks = layout?.displayChunks ?? []

  for (const s of plan.slots) {
    switch (s.kind) {
      case 'thinking-wait':
        thinking.push(`  ${s.label}`)
        break
      case 'top-reasoning':
        reasoning.push(`  ${shrink(s.text, 4000)}`)
        break
      case 'plan-top':
        planLines.push(`  ${shrink(s.text, 4000)}`)
        break
      case 'reasoning-pending':
        reasoning.push(`  (pending seg=${s.segIndex})`)
        break
      case 'live-tail':
      case 'plain-body':
      case 'legacy-body':
        body.push(`  [${s.kind}] ${shrink(s.text, 4000)}`)
        break
      case 'tool-row':
        toolRows.push(formatToolRowDetail(s.toolCallIds, tools))
        break
      case 'chunk': {
        const ch = chunks[s.chunkIndex]
        exploring.push(ch ? formatChunkDetail(ch, s.chunkIndex) : `chunk#${s.chunkIndex}:?`)
        break
      }
      case 'legacy-tools':
        toolRows.push('  legacy-tools（整批）')
        break
      case 'orphan-tools':
        toolRows.push(`  orphan-tools×${s.tools.length}`)
        break
      default:
        break
    }
  }

  if (thinking.length) sections.push(`[正在思考中]\n${thinking.join('\n')}`)
  if (reasoning.length) sections.push(`[思考]\n${reasoning.join('\n')}`)
  if (planLines.length) sections.push(`[计划]\n${planLines.join('\n')}`)
  if (body.length) sections.push(`[正文]\n${body.join('\n')}`)
  if (toolRows.length) sections.push(`[工具]\n${toolRows.join('\n\n')}`)
  if (exploring.length) sections.push(`[Exploring]\n${exploring.join('\n\n')}`)
  return sections.join('\n\n')
}

function toolRowChip(tool: unknown): string {
  const t = tool as Record<string, unknown>
  const id = String(t.tool_call_id ?? t.id ?? '').trim()
  const name = String(resolveEffectiveToolName(t) || '').trim() || '?'
  const st = String(t.status || '').trim() || '-'
  const preview = String(t._aguiArgsPreview || '').trim()
  const tail = id.length > 8 ? id.slice(-8) : id || 'no-id'
  return `${name}:${tail}(${st})${preview ? ` ${preview}` : ''}`
}

/** MessageRow：当前气泡完整展示快照 */
export function logStreamCompareUiDisplay(opts: {
  row: DisplayRow
  plan: AssistantBubbleDisplayPlan
  sessionKey?: string
}): void {
  if (!isStreamCompareFileLogOn()) return
  if (opts.row.role !== '_stream' && opts.row.role !== 'assistant') return
  const target = resolveLogTarget(opts.sessionKey, opts.row.runId)
  if (!target) return
  ensureSessionBuffers(target.sessionLogId)
  const layout = opts.plan.layout
  const turnNo = ensureSessionBuffers(target.sessionLogId).runs[target.runLogId]?.turnNo
  const timeline = formatStreamTurnTimelineMirror({
    segments: opts.row.segments || [],
    openText: opts.row.text || '',
    streamTextPhase: opts.row.streamTextPhase,
    tools: opts.row.tools || [],
    reasoningSegments: opts.row.reasoningSegments,
  })
  const header = [
    turnNo ? `turn=${turnNo}` : '',
    `session=${target.sessionLogId}`,
    `run=${target.runLogId}`,
    `path=${opts.plan.path}`,
    layout ? `phase=${layout.streamTextPhase}` : '',
    `streaming=${opts.row.role === '_stream' ? 1 : 0}`,
  ]
    .filter(Boolean)
    .join(' | ')
  appendUiSnapshotPart(target.sessionLogId, target.runLogId, header, formatSlotsBySection(opts.plan, opts.row.tools || []))
  const tl = String(timeline || '').trim()
  if (tl) appendUiSnapshotPart(target.sessionLogId, target.runLogId, '[timeline]', tl)
  if (opts.row.aguiTurn) {
    appendUiSnapshotPart(
      target.sessionLogId,
      target.runLogId,
      '[agui-order]',
      formatAgUiTurnOrderMirror(opts.row.aguiTurn),
    )
  }
}

/** MessageRow：row.tools 状态摘要（并入 ui-display） */
export function logStreamCompareUiStreamTools(opts: {
  row: DisplayRow
  tools: unknown[]
  sessionKey?: string
  isStreaming?: boolean
}): void {
  if (!isStreamCompareFileLogOn()) return
  if (opts.row.role !== '_stream' && opts.row.role !== 'assistant') return
  const target = resolveLogTarget(opts.sessionKey, opts.row.runId)
  if (!target) return
  const allTools = opts.tools || []
  const visibleTools = allTools.filter(
    (t) => t && typeof t === 'object' && !toolOmitFromChatPanel(t as Record<string, unknown>),
  )
  const chips = visibleTools.slice(0, 48).map(toolRowChip)
  const more = visibleTools.length > 48 ? `\n  …+${visibleTools.length - 48}` : ''
  const body = [
    `streaming=${opts.isStreaming ? 1 : 0} total=${allTools.length} visible=${visibleTools.length}`,
    chips.length ? chips.map((c) => `  ${c}`).join('\n') + more : '  (empty)',
  ].join('\n')
  appendUiSnapshotPart(target.sessionLogId, target.runLogId, '[工具摘要]', body)
}

/** displayChunks 明细（并入 ui-display） */
export function logStreamCompareUiChunks(opts: {
  row: DisplayRow
  plan: AssistantBubbleDisplayPlan
  sessionKey?: string
}): void {
  if (!isStreamCompareFileLogOn()) return
  if (opts.row.role !== '_stream' && opts.row.role !== 'assistant') return
  const target = resolveLogTarget(opts.sessionKey, opts.row.runId)
  if (!target) return
  const chunks = opts.plan.layout?.displayChunks ?? []
  if (!chunks.length) return
  const body = chunks.map((c, i) => formatChunkDetail(c, i)).join('\n\n')
  appendUiSnapshotPart(target.sessionLogId, target.runLogId, '[chunks/layout]', body)
}

export type ToolCallListRenderDiag = {
  filterIds?: string[]
  toolsCount: number
  listCount: number
  isStreaming: boolean
  activityGrouped: boolean
  nestedInExploring: boolean
  willReturnNull: boolean
  resolved: Array<{
    id: string
    name: string
    kind: string
    omitStreaming: boolean
    renderPath: string
    pending: boolean
    displayPath?: string
    hasStats?: boolean
  }>
  unmatchedFilterIds?: string[]
}

function isFileEditToolKindForDiag(toolKind: string): boolean {
  return (
    toolKind === 'write' ||
    toolKind === 'replace' ||
    toolKind === 'delete' ||
    toolKind === 'write_file' ||
    toolKind === 'str_replace' ||
    toolKind === 'write_to_file' ||
    toolKind === 'replace_in_file' ||
    toolKind === 'delete_file'
  )
}

/** ToolCallList：filterIds 解析与渲染路径诊断 */
export function buildToolCallListRenderDiag(opts: {
  tools?: unknown[]
  filterIds?: string[]
  list: unknown[]
  isStreaming: boolean
  activityGrouped: boolean
  nestedInExploring: boolean
  planExecConfirm?: unknown
}): ToolCallListRenderDiag {
  const filterIds = (opts.filterIds || []).map((id) => String(id).trim()).filter(Boolean)
  const useActivityFold =
    !opts.nestedInExploring &&
    opts.activityGrouped !== false &&
    opts.list.length > 0
  const resolved = opts.list.map((tool) => {
    const t = tool as Record<string, unknown>
    const id = String(t.tool_call_id ?? t.id ?? '').trim() || 'no-id'
    const name = String(resolveEffectiveToolName(t) || '').trim() || '?'
    const kind = resolveToolKey(t)
    const omitStreaming =
      opts.isStreaming &&
      toolOmitFromStreamingChatPanel(t) &&
      !t._aguiPhase &&
      !t._aguiTracked
    const inFold = useActivityFold || opts.nestedInExploring
    let renderPath = 'collapsible'
    if (omitStreaming && !opts.nestedInExploring) renderPath = 'null-row'
    else if (omitStreaming && opts.nestedInExploring) renderPath = 'collapsible'
    else if (kind === 'subagent') renderPath = 'subagent'
    else if (kind === 'worker') renderPath = 'worker'
    else if (isFileEditToolKindForDiag(kind) && !inFold) renderPath = 'file-mutation-line'
    const inputObj = getToolInputObjectFromRow(t)
    const writeProgress =
      t._writeProgress && typeof t._writeProgress === 'object'
        ? (t._writeProgress as { path?: string; lines_added?: number; lines_removed?: number })
        : null
    const resolvedPath =
      extractPathFromToolInput(t.arguments ?? t.input ?? t.args, inputObj) ||
      (typeof writeProgress?.path === 'string' && writeProgress.path.trim()
        ? writeProgress.path.trim()
        : null) ||
      extractPathFromToolOutput(name, t.output) ||
      null
    const fileName = resolvedPath
      ? String(resolvedPath).replace(/\\/g, '/').split('/').filter(Boolean).pop() || resolvedPath
      : ''
    const hasStats = Boolean(
      writeProgress &&
        (Number(writeProgress.lines_added) || Number(writeProgress.lines_removed)),
    )
    return {
      id: shrink(id, 32),
      name,
      kind,
      omitStreaming,
      renderPath,
      pending: !!t._streamToolPending || !!t._filterIdStub,
      ...(renderPath === 'file-mutation-line'
        ? { displayPath: fileName || (opts.isStreaming ? '…' : ''), hasStats }
        : {}),
    }
  })
  const unmatchedFilterIds = filterIds.filter(
    (fid) => !filterIdMatchedInList(fid, opts.list),
  )
  return {
    filterIds: filterIds.length ? filterIds.map((id) => shrink(id, 32)) : undefined,
    toolsCount: (opts.tools || []).length,
    listCount: opts.list.length,
    isStreaming: opts.isStreaming,
    activityGrouped: opts.activityGrouped !== false,
    nestedInExploring: opts.nestedInExploring,
    willReturnNull: !opts.list.length && !opts.planExecConfirm,
    resolved,
    unmatchedFilterIds: unmatchedFilterIds.length ? unmatchedFilterIds.map((id) => shrink(id, 32)) : undefined,
  }
}

/** ToolCallList 渲染诊断（并入 ui-display） */
export function logStreamCompareToolRender(opts: {
  sessionKey?: string
  runId?: string
  source: string
  diag: ToolCallListRenderDiag
}): void {
  if (!isStreamCompareFileLogOn()) return
  if (!opts.diag.isStreaming) return
  const target = resolveLogTarget(opts.sessionKey, opts.runId)
  if (!target) return
  const d = opts.diag
  const rows = d.resolved.map(
    (r) =>
      `  ${r.name}/${r.kind} id=${r.id} path=${r.renderPath}${
        r.displayPath != null ? ` file=${r.displayPath}` : ''
      }${r.hasStats ? ' stats=1' : ''}${r.omitStreaming ? ' omitStream' : ''}${
        r.pending ? ' pending' : ''
      }`,
  )
  const body = [
    `src=${opts.source}`,
    `filter=${d.filterIds?.join(',') || '-'}`,
    `tools=${d.toolsCount} list=${d.listCount}`,
    `stream=${d.isStreaming ? 1 : 0} grouped=${d.activityGrouped ? 1 : 0} nested=${d.nestedInExploring ? 1 : 0}`,
    d.willReturnNull ? 'RETURN_NULL' : 'RENDER',
    d.unmatchedFilterIds?.length ? `unmatched=[${d.unmatchedFilterIds.join(',')}]` : '',
    rows.length ? rows.join('\n') : '  (empty)',
  ]
    .filter(Boolean)
    .join('\n')
  appendUiSnapshotPart(target.sessionLogId, target.runLogId, '[工具渲染]', body)
}

/** 浏览器 dev：导出内存缓冲供复制对比 */
export function dumpStreamCompareBuffers(sessionKey?: string, runId?: string): {
  sseRecv: string[]
  uiDisplay: string[]
  sessionLogId: string
  runLogId: string
} {
  const store = ensureStore()
  const target = resolveLogTarget(sessionKey || store.activeSessionLogId, runId)
  if (!target) {
    return { sseRecv: [], uiDisplay: [], sessionLogId: '', runLogId: '' }
  }
  const runBuf = store.sessions[target.sessionLogId]?.runs[target.runLogId]
  return {
    sseRecv: runBuf ? [...runBuf.sseRecv] : [],
    uiDisplay: runBuf ? [...runBuf.uiDisplay] : [],
    sessionLogId: target.sessionLogId,
    runLogId: target.runLogId,
  }
}

if (typeof window !== 'undefined') {
  const w = window as Window & {
    __evoflowStreamCompareDump?: (sessionKey?: string) => ReturnType<typeof dumpStreamCompareBuffers>
  }
  w.__evoflowStreamCompareDump = dumpStreamCompareBuffers
}