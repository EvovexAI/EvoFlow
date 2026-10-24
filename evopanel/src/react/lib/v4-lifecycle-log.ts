/**
 * V4 会话打开 / 订阅 / 首帧生命周期诊断。
 *
 * ## 落点（排查「有历史却空白 / 卡在等首帧 / 特别慢」）
 * 1. DevTools Console：过滤 `[v4-life]` 或 `[v4-open]`
 * 2. 桌面端：`~/.evoflow/logs/frontend-YYYY-MM-DD.log`
 *    （`append_frontend_log`，不依赖 PROD console 镜像）
 * 3. 若 stream-compare 开着：同会话 `…/pending/v4-recv.log`（或当前 active run）
 * 4. 环形缓冲：`window.__evoflowV4Life` / localStorage `EVOFLOW_V4_LIFE_RING`
 *
 * 关闭：localStorage.setItem('EVOFLOW_V4_LIFE_LOG', '0')
 *
 * 日志行优先带中文 `zh` 字段；打开链路还会带 `sinceClickMs`（距侧栏点击的毫秒），
 * 方便直接拆：点开 → acquire → ACK → SSE 大包拼装 → 首帧 → 上屏 各卡多久。
 */
import { logStreamCompareV4Lifecycle } from './stream-compare-file-log.js'

const PREFIX = '[v4-life]'
const RING_MAX = 120
const LS_RING_KEY = 'EVOFLOW_V4_LIFE_RING'
const LS_ENABLE_KEY = 'EVOFLOW_V4_LIFE_LOG'
const DEDUPE_MS = 2_500

export type V4LifeEvent =
  | 'session_click'
  | 'ui_render'
  | 'path'
  | 'subscribe'
  | 'subscribe_ack'
  | 'activate'
  | 'sse_start'
  | 'sse_connected'
  | 'sse_bad_response'
  | 'sse_disconnected'
  | 'sse_error'
  | 'sse_frame_assemble'
  | 'frame_early_stage'
  | 'frame_snapshot'
  | 'frame_deltas'
  | 'open_acquire'
  | 'open_warm'
  | 'open_ready'
  | 'connecting_tick'
  | 'connecting_stuck'
  | 'wire_parse_failed'
  | 'dispatch_failed'

/** 一次「点开历史」的计时锚点（下一次点击会覆盖）。 */
type V4OpenTrace = {
  sessionKey: string
  threadId?: string
  startedAt: number
}

let openTrace: V4OpenTrace | null = null

function normalizeThreadId(raw: string | null | undefined): string | undefined {
  const t = String(raw || '').trim()
  if (!t) return undefined
  if (t.startsWith('conversation/')) {
    const id = t.slice('conversation/'.length).trim()
    return id || t
  }
  return t
}

export type V4LifeLogInput = {
  event: V4LifeEvent | string
  /** 给人看的中文说明（会写进 frontend 日志主文案）。 */
  zh?: string | null
  sessionKey?: string | null
  threadId?: string | null
  level?: 'info' | 'warn' | 'error'
  detail?: Record<string, unknown>
  /** 为 true 时不做 2.5s 去重（进度 tick / 大包拼装必须条条留下）。 */
  skipDedupe?: boolean
}

/** 侧栏点开会话时打点：后续各阶段日志带 sinceClickMs。 */
export function markV4OpenTrace(opts: {
  sessionKey: string
  threadId?: string | null
}): void {
  const sessionKey = String(opts.sessionKey || '').trim()
  if (!sessionKey) return
  const threadId = normalizeThreadId(opts.threadId)
  openTrace = {
    sessionKey,
    ...(threadId ? { threadId } : {}),
    startedAt: Date.now(),
  }
}

/** bridge / transport 拿到 threadId 后绑到当前打开 trace。 */
export function bindV4OpenThread(threadId: string | null | undefined): void {
  if (!openTrace) return
  const id = normalizeThreadId(threadId)
  if (!id) return
  openTrace.threadId = id
}

/**
 * 距「本次点开」的毫秒。threadId/sessionKey 对不上当前 trace 时返回 null
 *（避免把上一会话的耗时写到下一会话日志里）。
 */
export function v4OpenSinceClickMs(opts?: {
  sessionKey?: string | null
  threadId?: string | null
}): number | null {
  if (!openTrace) return null
  const sk = String(opts?.sessionKey || '').trim()
  const tid = normalizeThreadId(opts?.threadId)
  if (sk && sk !== openTrace.sessionKey) return null
  if (tid && openTrace.threadId && tid !== openTrace.threadId) return null
  return Math.max(0, Date.now() - openTrace.startedAt)
}

function attachOpenTiming(
  detail: Record<string, unknown> | undefined,
  sessionKey?: string,
  threadId?: string,
): Record<string, unknown> | undefined {
  const since = v4OpenSinceClickMs({ sessionKey, threadId })
  if (since == null) return detail
  return { ...(detail || {}), sinceClickMs: since }
}

export type V4LifeRecord = {
  at: string
  atMs: number
  event: string
  level: 'info' | 'warn' | 'error'
  zh?: string
  sessionKey?: string
  threadId?: string
  detail?: Record<string, unknown>
}

const ring: V4LifeRecord[] = []
const recent = new Map<string, number>()

function enabled(): boolean {
  try {
    if (typeof localStorage === 'undefined') return true
    return localStorage.getItem(LS_ENABLE_KEY) !== '0'
  } catch {
    return true
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function persistToFrontendLog(level: 'info' | 'warn' | 'error', line: string): void {
  try {
    if (typeof window === 'undefined') return
    const w = window as Window & {
      __TAURI__?: { core?: { invoke?: unknown } }
      __TAURI_INTERNALS__?: unknown
    }
    if (!(w.__TAURI__?.core?.invoke || w.__TAURI_INTERNALS__)) return
    void import('@tauri-apps/api/core')
      .then((m) => m.invoke('append_frontend_log', { level, message: line.slice(0, 11_500) }))
      .catch(() => {})
  } catch {
    /* best-effort */
  }
}

function pushRing(rec: V4LifeRecord): void {
  ring.push(rec)
  while (ring.length > RING_MAX) ring.shift()
  try {
    if (typeof window !== 'undefined') {
      ;(window as Window & { __evoflowV4Life?: V4LifeRecord[] }).__evoflowV4Life = [...ring]
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LS_RING_KEY, JSON.stringify(ring.slice(-RING_MAX)))
    }
  } catch {
    /* quota */
  }
}

/** 根据桥接 path / store 状态生成「为何还没渲染历史」的中文原因。 */
export function describeV4NotRenderedYet(opts: {
  path?: string | null
  storeStatus?: string | null
  lease?: boolean | null
  rowCount?: number | null
  hasSubscription?: boolean | null
  reason?: string | null
}): string {
  const path = String(opts.path || '').trim()
  if (path === 'legacy:off' || opts.reason === 'V4 开关关闭') {
    return '未渲染 V4 历史页：V4 开关关闭，走了老面板。'
  }
  if (path === 'legacy:no-thread' || opts.reason === '会话尚无 threadId') {
    return '未渲染历史页：当前会话还没有 threadId（无法订阅 V4 帧），界面只能显示加载/空态。'
  }
  if (!opts.lease) {
    return '未渲染历史页：会话租约尚未对齐（刚切换会话，V4 store 还没挂上）。'
  }
  const st = String(opts.storeStatus || '').trim()
  if (st === 'connecting' || !st) {
    return '未渲染历史页：已点开会话，正在等 V4 订阅 ACK / 首帧 snapshot；此时只显示「加载中」，不会回落老面板。'
  }
  if (st === 'live' && (opts.rowCount == null || opts.rowCount === 0) && opts.hasSubscription !== false) {
    return '未渲染历史页：订阅已成功（store=live），但首帧 snapshot 还没到——常见于 initial 帧丢失/迟到；发消息或超时 recovery 后才会出历史。'
  }
  if (st === 'error') {
    return '未渲染历史页：V4 投影 store 已报错，需要重连或查 frames SSE / subscribe。'
  }
  if (path === 'v4-connecting') {
    return '未渲染历史页：仍在 v4-connecting（有 threadId，尚无可用 snapshot）。'
  }
  return `未渲染历史页：path=${path || '?'} storeStatus=${st || '?'}。`
}

/** 历史页已经渲染出来时的中文说明。 */
export function describeV4Rendered(opts: {
  rowCount?: number | null
  draftEmpty?: boolean | null
  storeStatus?: string | null
}): string {
  const n = opts.rowCount ?? 0
  if (opts.draftEmpty) {
    return '历史页已渲染：确认为空草稿（居中问候语+输入框），不是「还在加载」。'
  }
  if (n > 0) {
    return `历史页已渲染：V4 时间线已挂上，快照含 ${n} 行（含工具/正文等）。`
  }
  return '历史页已渲染：V4 时间线已挂上，但当前快照行数为 0（空会话或窗口尚未含行）。'
}

/**
 * 记录一条 V4 生命周期事件（默认开启，落盘 frontend + stream-compare）。
 * 有 `zh` 时，frontend 日志主文案用中文，便于直接排查「何时渲染 / 为何空白」。
 */
export function logV4Life(input: V4LifeLogInput): void {
  if (!enabled()) return
  const event = String(input.event || '').trim() || 'unknown'
  const zh = String(input.zh || '').trim() || undefined
  const sessionKey = String(input.sessionKey || '').trim() || undefined
  const threadId = normalizeThreadId(input.threadId)
  const level = input.level || 'info'
  const detail = attachOpenTiming(
    input.detail && typeof input.detail === 'object' ? { ...input.detail } : undefined,
    sessionKey,
    threadId,
  )

  if (!input.skipDedupe) {
    const dedupeKey = `${event}|${sessionKey || ''}|${threadId || ''}|${zh || ''}|${safeJson(detail || {}).slice(0, 100)}`
    const now = Date.now()
    const last = recent.get(dedupeKey)
    if (last != null && now - last < DEDUPE_MS) return
    recent.set(dedupeKey, now)
  }

  const now = Date.now()
  const rec: V4LifeRecord = {
    at: new Date(now).toISOString(),
    atMs: now,
    event,
    level,
    ...(zh ? { zh } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(threadId ? { threadId } : {}),
    ...(detail ? { detail } : {}),
  }
  pushRing(rec)

  const since = detail && typeof detail.sinceClickMs === 'number' ? ` +${detail.sinceClickMs}ms` : ''
  const line = zh ? `${PREFIX}${since} ${zh}` : `${PREFIX}${since} ${event}`
  const payload = {
    event,
    ...(zh ? { zh } : {}),
    sessionKey,
    threadId,
    ...(detail || {}),
  }
  if (level === 'error') console.error(line, payload)
  else if (level === 'warn') console.warn(line, payload)
  else console.info(line, payload)

  persistToFrontendLog(level, `${line} ${safeJson(payload)}`)

  try {
    logStreamCompareV4Lifecycle({
      event,
      sessionKey,
      threadId,
      detail: {
        ...(zh ? { zh } : {}),
        ...(detail || {}),
      },
    })
  } catch {
    /* stream-compare 关着或失败不挡主路径 */
  }
}

/** 测试 / 控制台：最近生命周期事件 */
export function getV4LifeRing(): V4LifeRecord[] {
  return [...ring]
}
