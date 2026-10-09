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

/** v5.8 起默认开启；localStorage='0' / 'false' 时关闭；未设值时按 ON 走 */
export function isStreamCompareFileLogOn(): boolean {
  try {
    if (typeof localStorage === 'undefined') return true
    const v = localStorage.getItem(LS_KEY)
    if (v == null) return true
    return v !== '0' && v !== 'false'
  } catch {
    return true
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

function appendFileLine(
  sessionLogId: string,
  runLogId: string,
  channel: CompareChannel,
  line: string,
): void {
  const sid = String(sessionLogId || '').trim()
  const rid = sanitizeRunLogId(runLogId)
  if (!sid || !rid) return
  const text = String(line || '').slice(0, MAX_LINE)
  if (!text) return
  // 同步 push 到内存缓冲（Tauri 落盘是 fire-and-forget）
  const runBuf = ensureRunBuffers(sid, rid, ensureSessionBuffers(sid).runs[rid]?.turnNo || 0)
  const key = channel === 'sse-recv' ? 'sseRecv' : 'uiDisplay'
  runBuf[key].push(text)
  const tag = channel === 'sse-recv' ? '[sse-recv]' : '[ui-display]'

  console.log(tag, `[${sid}/${rid}]`, text)
  if (isTauriDesktop()) {
    try {
      void import('@tauri-apps/api/core').then((m) =>
        m.invoke('append_stream_compare_log', {
          channel,
          sessionKey: sid,
          runId: rid,
          message: text,
        }),
      )
    } catch {
      /* best-effort */
    }
  }
}

function showEnableBannerOnce(): void {
  if (compareLogBannerShown || !isStreamCompareFileLogOn()) return
  compareLogBannerShown = true
  const home = isTauriDesktop()
    ? '~/.evoflow/logs/stream-compare/{sessionKey}/{runId}/sse-recv.log + ui-display.log'
    : 'window.__evoflowStreamCompare.sessions（非 Tauri）'
   
  console.log(
    `[stream-compare] 默认已开启，每个会话 2 个文件 → ${home}；关闭：localStorage.setItem('${LS_KEY}','0')`,
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
  // internal-mirror-* 段（老 plain-path 内部自省）走独立直接 flush，不进 dom-view 的 acc 列表
  // —— dom-view 是「用户看到什么」的事实源，必须保持一个完整块不被切碎。
  if (section.startsWith('[internal-mirror') || section.startsWith('[file-changes]')) {
    flushStandaloneSection(sid, rid, section, text)
    return
  }
  // 同 section 名覆盖（最后一次胜出），不同 section 累加 —— 否则同一 dom-view 每次 render
  // 都会把整段重复写入 uiDisplay buffer。
  const sameSectionIdx = acc.parts.findIndex((p) => p.startsWith(`${section}\n`))
  if (sameSectionIdx >= 0) {
    acc.parts[sameSectionIdx] = `${section}\n${text}`
    // 其后多余的同 section 副本（被错误 push 进来的）清掉
    for (let i = acc.parts.length - 1; i > sameSectionIdx; i--) {
      if (acc.parts[i].startsWith(`${section}\n`)) acc.parts.splice(i, 1)
    }
  } else {
    acc.parts.push(`${section}\n${text}`)
  }
  acc.sig = acc.parts.join('\n')
  scheduleUiSnapshotClose(sid, rid)
}

/** 独立直写 ui-display 一行块，不走 acc 合并 —— 供 internal-mirror / file-changes 用 */
function flushStandaloneSection(
  sessionLogId: string,
  runLogId: string,
  section: string,
  body: string,
): void {
  const block = ['---', `${section}\n${body}`, '---'].join('\n')
  void appendFileLine(sessionLogId, runLogId, 'ui-display', formatCompareLine(sessionLogId, runLogId, block))
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

/** buildStreamDisplayRow / drain：AG-UI 内部态 + compacted 封存段
 * v5.9 默认 no-op：dom-view 已经覆盖了"用户看到什么"，这里再写一份 internal-mirror 重复
 * 且按帧打会爆日志。调用方传 `forceWrite: true` 仍能写（比如 compact 后 drain 想看封存快照）。
 */
export function logStreamCompareAgUiInternals(opts: {
  sessionKey?: string
  runId?: string
  aguiTurn?: AgUiTurnState | null
  compactedParts?: CompactedStreamPart[]
  label?: string
  forceWrite?: boolean
}): void {
  if (!isStreamCompareFileLogOn()) return
  if (!opts.forceWrite) return
  const target = resolveLogTarget(opts.sessionKey, opts.runId)
  if (!target) return
  const label = String(opts.label || 'agui-internals').trim()
  const chunks: string[] = []
  if (opts.aguiTurn) chunks.push(formatAgUiTurnOrderMirror(opts.aguiTurn))
  if (opts.compactedParts?.length) {
    chunks.push('compactedParts:\n' + formatCompactedPartsMirror(opts.compactedParts))
  }
  if (!chunks.length) return
  appendUiSnapshotPart(
    target.sessionLogId,
    target.runLogId,
    `[internal-mirror ${label}]`,
    chunks.join('\n\n'),
  )
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
  appendUiSnapshotPart(target.sessionLogId, target.runLogId, '[internal-mirror agui-drain]', body)
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

/**
 * v5.9 MessageRow：DOM 视角 1:1 快照
 * 由 MessageRow 在 render 时构造「用户看到的样子」并传入 —— 这是日志的**权威**字段，
 * 替代之前由 plan/row 反推的 plain path timeline / agui-order 等老格式（那些降级到
 * [internal-mirror] section，只用于排障对照，不再作为「用户看到什么」的事实来源）。
 *
 * 典型输入（折叠态默认）：
 *   {
 *     foldOpen: false,                       // data-history-open
 *     head: '已工作 32 秒',                    // msg-turn-history-fold-label
 *     gear: 'off' | 'streaming' | 'spinner',  // StreamRunStatusLine
 *     chunks: [
 *       { kind: 'flat-activity', pieces: [
 *           { kind: 'tools', role: 'latest', tools: [{name,status,file,diff,elapsed,time}, …] },
 *           { kind: 'text',   role: 'latest', text: '…' },
 *         ] },
 *       { kind: 'msg-text',   role: 'final-reply',  text: '…', markdown: {p, table, ul} },
 *       { kind: 'msg-text',   role: 'plan-text',    text: '…' },
 *     ],
 *     fileChanges: ['simple.md', …],          // 底部 ChangedFilesSummaryRow
 *   }
 */
export function logStreamCompareDomView(opts: {
  sessionKey?: string
  runId?: string
  turnNo?: number
  foldOpen: boolean
  head: string
  gear: 'off' | 'streaming' | 'spinner'
  chunks: UiDomChunk[]
  fileChanges?: string[]
  /** v5.9：让 log 能直接看到调用点的 row 状态，便于诊断「齿轮抖/stop 流但 SSE 还在来」。 */
  diag?: {
    rowRole?: string
    rowState?: string
    isStreamingEffective?: boolean
    turnStartMsResolved?: number | null
  }
}): void {
  if (!isStreamCompareFileLogOn()) return
  const target = resolveLogTarget(opts.sessionKey, opts.runId)
  if (!target) return
  ensureSessionBuffers(target.sessionLogId)
  const body = formatDomView(opts.foldOpen, opts.head, opts.gear, opts.chunks, opts.fileChanges)
  if (!body.trim()) return
  // diag 字段不参与 section 名 —— 否则同一 row.role/turnStartMs 的覆盖会被 diag 抖动打破，
  // 同一 `---` 块里堆 3 个不同 turnStartMs 的 dom-view。diag 写到 body 首行作为注释。
  const header = [
    `turn=${opts.turnNo ?? ensureSessionBuffers(target.sessionLogId).runs[target.runLogId]?.turnNo ?? '-'}`,
    `session=${target.sessionLogId}`,
    `run=${target.runLogId}`,
  ].join(' | ')
  const diagHeader = [
    opts.diag?.rowRole ? `row.role=${opts.diag.rowRole}` : '',
    opts.diag?.rowState != null ? `row.state=${JSON.stringify(opts.diag.rowState)}` : '',
    opts.diag?.isStreamingEffective != null
      ? `isStreamingEff=${opts.diag.isStreamingEffective ? 1 : 0}`
      : '',
    opts.diag?.turnStartMsResolved != null
      ? `turnStartMs=${opts.diag.turnStartMsResolved}`
      : '',
    opts.diag?.segmentsCount != null ? `segsN=${opts.diag.segmentsCount}` : '',
    opts.diag?.rowTextLen != null ? `rowTextLen=${opts.diag.rowTextLen}` : '',
    opts.diag?.rawTextLen != null ? `rawTextLen=${opts.diag.rawTextLen}` : '',
    opts.diag?.toolsCount != null ? `toolsN=${opts.diag.toolsCount}` : '',
    opts.diag?.segmentsToolIds != null
      ? `segToolIds=[${opts.diag.segmentsToolIds.join(',')}]`
      : '',
    opts.diag?.toolStatus != null ? `toolStatus=[${opts.diag.toolStatus.join(',')}]` : '',
    opts.diag?.slots && opts.diag.slots.length
      ? `slots=[${opts.diag.slots.join('|')}]`
      : opts.diag?.slots
        ? `slots=[]`
        : '',
  ]
    .filter(Boolean)
    .join(' | ')
  const bodyWithDiag = diagHeader ? `# diag: ${diagHeader}\n${body}` : body
  appendUiSnapshotPart(target.sessionLogId, target.runLogId, header, bodyWithDiag)
  // fileChanges 也单独写一份，便于 grep
  if (opts.fileChanges && opts.fileChanges.length) {
    appendUiSnapshotPart(
      target.sessionLogId,
      target.runLogId,
      '[file-changes]',
      opts.fileChanges.map((p, i) => `  #${i} ${p}`).join('\n'),
    )
  }
}

export type UiDomChunk =
  | {
      kind: 'flat-activity'
      pieces: UiDomPiece[]
    }
  | {
      kind: 'msg-text'
      role: 'final-reply' | 'plan-text' | 'live-tail' | 'plain-body' | 'top-reasoning' | 'reasoning-pending' | 'pending-text'
      text: string
      markdown?: { paragraphs: number; tables: number; lists: number; codeBlocks: number }
    }
  | {
      kind: 'legacy-tools'
      tools: { name: string; status: string; id: string }[]
    }
  | {
      kind: 'spinner'
      label: string
    }

export type UiDomPiece =
  | {
      kind: 'tools'
      role: 'latest' | 'history'
      tools: { name: string; status: string; file?: string; diff?: string; elapsed?: string; time?: string; id: string }[]
    }
  | {
      kind: 'text'
      role: 'latest' | 'history'
      text: string
    }
  | {
      kind: 'reasoning'
      role: 'latest' | 'history'
      text: string
      durationLabel?: string
    }

function formatDomView(
  foldOpen: boolean,
  head: string,
  gear: 'off' | 'streaming' | 'spinner',
  chunks: UiDomChunk[],
  fileChanges?: string[],
): string {
  const out: string[] = []
  out.push(`[fold=${foldOpen ? 'open' : 'closed'}] [gear=${gear}]`)
  out.push(`head: ${head || '(empty)'}`)
  if (!chunks.length) {
    out.push('body: (empty)')
  } else {
    out.push('body:')
    chunks.forEach((c, i) => {
      if (c.kind === 'flat-activity') {
        if (!c.pieces.length) {
          out.push(`  chunk#${i} flat-activity-chunk (empty)`)
          return
        }
        out.push(`  chunk#${i} flat-activity-chunk`)
        c.pieces.forEach((p, pi) => {
          if (p.kind === 'tools') {
            out.push(
              `    piece#${pi} tools  role=${p.role}  count=${p.tools.length}${p.role === 'history' ? '  [hidden when fold=closed]' : ''}`,
            )
            for (const t of p.tools) {
              const file = t.file ? ` file=${t.file}` : ''
              const diff = t.diff ? ` ${t.diff}` : ''
              const elapsed = t.elapsed ? ` ${t.elapsed}` : ''
              const time = t.time ? `  ${t.time}` : ''
              out.push(`      - ${t.name}(${t.status}) id=${t.id}${file}${diff}${elapsed}${time}`)
            }
          } else if (p.kind === 'reasoning') {
            const preview = oneLine(p.text || '').slice(0, 240)
            out.push(
              `    piece#${pi} reasoning  role=${p.role}  dur=${p.durationLabel ?? '-'}${p.role === 'history' ? '  [hidden when fold=closed]' : ''}`,
            )
            out.push(`      text: ${preview || '(empty)'}`)
          } else {
            const preview = oneLine(p.text || '').slice(0, 240)
            out.push(
              `    piece#${pi} ${p.kind}  role=${p.role}${p.role === 'history' ? '  [hidden when fold=closed]' : ''}`,
            )
            out.push(`      text: ${preview || '(empty)'}`)
          }
        })
      } else if (c.kind === 'msg-text') {
        const md = c.markdown
        const mdTag = md
          ? ` p=${md.paragraphs} table=${md.tables} list=${md.lists} code=${md.codeBlocks}`
          : ''
        const preview = oneLine(c.text || '').slice(0, 360)
        out.push(`  chunk#${i} msg-text role=${c.role}${mdTag}`)
        out.push(`    text: ${preview || '(empty)'}`)
      } else if (c.kind === 'legacy-tools') {
        out.push(`  chunk#${i} legacy-tools count=${c.tools.length}`)
        for (const t of c.tools.slice(0, 24)) {
          out.push(`    - ${t.name}(${t.status}) id=${t.id}`)
        }
        if (c.tools.length > 24) out.push(`    …+${c.tools.length - 24}`)
      } else if (c.kind === 'spinner') {
        out.push(`  chunk#${i} spinner label="${c.label}"`)
      }
    })
  }
  if (fileChanges && fileChanges.length) {
    out.push(`file-changes: ${fileChanges.length} 项 → ${fileChanges.map((p) => shrink(p, 80)).join(', ')}`)
  }
  return out.join('\n')
}

/**
 * v5.8 老格式：DisplayRow 推演的 plain path timeline / agui-order 等内省字段。
 * v5.9 起降级为 [internal-mirror]，**不**作为「用户看到什么」的事实来源；
 * 用户视角的 DOM 视图由 logStreamCompareDomView 写入。
 */
export function logStreamCompareUiDisplay(opts: {
  row: DisplayRow
  plan: AssistantBubbleDisplayPlan
  sessionKey?: string
  forceWrite?: boolean
}): void {
  if (!isStreamCompareFileLogOn()) return
  if (!opts.forceWrite) return
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
    `[internal-mirror] turn=${turnNo ?? '-'}`,
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
  if (tl) appendUiSnapshotPart(target.sessionLogId, target.runLogId, '[internal-mirror timeline]', tl)
  if (opts.row.aguiTurn) {
    appendUiSnapshotPart(
      target.sessionLogId,
      target.runLogId,
      '[internal-mirror agui-order]',
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
  forceWrite?: boolean
}): void {
  if (!isStreamCompareFileLogOn()) return
  if (!opts.forceWrite) return
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
  appendUiSnapshotPart(target.sessionLogId, target.runLogId, '[internal-mirror 工具摘要]', body)
}

/** displayChunks 明细（并入 ui-display） */
export function logStreamCompareUiChunks(opts: {
  row: DisplayRow
  plan: AssistantBubbleDisplayPlan
  sessionKey?: string
  forceWrite?: boolean
}): void {
  if (!isStreamCompareFileLogOn()) return
  if (!opts.forceWrite) return
  if (opts.row.role !== '_stream' && opts.row.role !== 'assistant') return
  const target = resolveLogTarget(opts.sessionKey, opts.row.runId)
  if (!target) return
  const chunks = opts.plan.layout?.displayChunks ?? []
  if (!chunks.length) return
  const body = chunks.map((c, i) => formatChunkDetail(c, i)).join('\n\n')
  appendUiSnapshotPart(target.sessionLogId, target.runLogId, '[internal-mirror chunks/layout]', body)
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
  forceWrite?: boolean
}): void {
  if (!isStreamCompareFileLogOn()) return
  if (!opts.forceWrite) return
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
  appendUiSnapshotPart(target.sessionLogId, target.runLogId, '[internal-mirror 工具渲染]', body)
}

/** 浏览器 dev：导出内存缓冲供复制对比 */
export function dumpStreamCompareBuffers(sessionKey?: string, runId?: string): {
  sseRecv: string[]
  uiDisplay: string[]
  sessionLogId: string
  runLogId: string
} {
  const store = ensureStore()
  // dump 场景下 explicit runId 优先于 activeRunBySession（active 永远指向最新 run，
  // 调试旧轮次需要按 explicit 拿到旧 buffer）
  const sessionLogId = resolveLogSessionId(sessionKey || store.activeSessionLogId)
  if (!sessionLogId) {
    return { sseRecv: [], uiDisplay: [], sessionLogId: '', runLogId: '' }
  }
  const explicit = sanitizeRunLogId(String(runId || '').trim())
  const active = activeRunBySession.get(sessionLogId) || ''
  const runLogId = explicit || active || 'pending'
  const runBuf = store.sessions[sessionLogId]?.runs[runLogId]
  return {
    sseRecv: runBuf ? [...runBuf.sseRecv] : [],
    uiDisplay: runBuf ? [...runBuf.uiDisplay] : [],
    sessionLogId,
    runLogId,
  }
}

if (typeof window !== 'undefined') {
  const w = window as Window & {
    __evoflowStreamCompareDump?: (sessionKey?: string) => ReturnType<typeof dumpStreamCompareBuffers>
    __evoflowStreamCompareFlush?: () => void
    __evoflowStreamCompareResetForTest?: () => void
  }
  w.__evoflowStreamCompareDump = dumpStreamCompareBuffers
  /** 测试 / 调试：立刻把当前未刷新的 ui-display 段落 flush 到内存缓冲（48ms 防抖外） */
  function flushAllUiSnapshots(): void {
    for (const [snapKey, acc] of uiSnapshotByRun.entries()) {
      if (acc.closeTimer) {
        clearTimeout(acc.closeTimer)
        acc.closeTimer = null
      }
      uiSnapshotByRun.delete(snapKey)
      if (!acc.parts.length) continue
      if (lastUiSigByRun.get(snapKey) === acc.sig) continue
      lastUiSigByRun.set(snapKey, acc.sig)
      const [sid, rid] = snapKey.split('/')
      const block = ['---', ...acc.parts, '---'].join('\n')
      void appendFileLine(sid, rid, 'ui-display', formatCompareLine(sid, rid, block))
    }
  }
  w.__evoflowStreamCompareFlush = flushAllUiSnapshots
  /** 测试用：清模块级 run 缓存，确保 beforeEach 后 markStreamCompareRun 总能 push TURN header */
  w.__evoflowStreamCompareResetForTest = () => {
    activeRunBySession.clear()
    lastSseSigByRun.clear()
    lastUiSigByRun.clear()
    uiSnapshotByRun.clear()
  }
}