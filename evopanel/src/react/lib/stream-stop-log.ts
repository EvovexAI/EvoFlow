/**
 * 对话流停止诊断日志（默认开启）。
 *
 * ## 日志落点（排查用）
 * 1. DevTools Console：过滤 `[stream-stop]`
 * 2. 桌面端落盘：`~/.evoflow/logs/frontend-YYYY-MM-DD.log`
 *    （显式 `append_frontend_log`，不依赖 PROD console 镜像；刷新后可 grep）
 * 3. 环形缓冲：`window.__evoflowStreamStops` / `localStorage['EVOFLOW_STREAM_STOP_RING']`
 *      copy(JSON.stringify(window.__evoflowStreamStops, null, 2))
 *
 * 关闭：localStorage.setItem('EVOFLOW_STREAM_STOP_LOG', '0')
 *
 * ## kind 诚实边界
 * - `normal`：收到协议结束标识（SSE final / AG-UI RUN_FINISHED|RUN_ERROR）
 * - `ui_stop`：走了 Composer/侧栏「停止」代码路径——只能说明点了停止按钮，
 *   **无法区分误触/故意**；页面刷新、超时、断流不会标成这个
 * - `abnormal`：无结束标识，且不是 UI 停止按钮 → 「莫名其妙停掉」主查对象
 *
 * 细粒度看 `trigger`（ui_stop_button / sse_final / sse_aborted /
 * stale_sending_watchdog / page_unload / …）。
 */

const PREFIX = '[stream-stop]'
const DEDUPE_MS = 8_000
const RING_MAX = 80
const LS_RING_KEY = 'EVOFLOW_STREAM_STOP_RING'
const LS_ENABLE_KEY = 'EVOFLOW_STREAM_STOP_LOG'

export type StreamStopKind = 'normal' | 'abnormal' | 'ui_stop'

export type StreamStopLogInput = {
  sessionKey?: string | null
  runId?: string | null
  /**
   * 细粒度触发源（排查主字段）。
   * 例：ui_stop_button / sse_final / sse_aborted / stale_sending_watchdog / page_unload
   */
  trigger?: string
  /** @deprecated 用 trigger；兼容旧调用 */
  reason?: string
  /** 是否收到协议结束标识（final / RUN_FINISHED / RUN_ERROR） */
  hasEndMarker: boolean
  /**
   * 仅当走了 stopSessionExecution / 停止按钮时为 true。
   * ≠「用户一定故意停」——误触也会是 true；刷新/超时不会。
   */
  fromUiStopButton?: boolean
  /** @deprecated 同 fromUiStopButton */
  userInitiated?: boolean
  detail?: Record<string, unknown>
}

export type StreamStopRecord = {
  at: string
  atMs: number
  kind: StreamStopKind
  trigger: string
  hasEndMarker: boolean
  fromUiStopButton: boolean
  sessionKey?: string
  runId?: string
  href?: string
  visibility?: string
  detail?: Record<string, unknown>
}

type DedupeEntry = { at: number; kind: StreamStopKind; trigger: string }

const recentStops = new Map<string, DedupeEntry>()
const ring: StreamStopRecord[] = []

function enabled(): boolean {
  try {
    if (typeof localStorage === 'undefined') return true
    return localStorage.getItem(LS_ENABLE_KEY) !== '0'
  } catch {
    return true
  }
}

function pageContext(): { href?: string; visibility?: string } {
  try {
    return {
      href: typeof location !== 'undefined' ? String(location.href || '').slice(0, 240) : undefined,
      visibility:
        typeof document !== 'undefined' ? String(document.visibilityState || '') : undefined,
    }
  } catch {
    return {}
  }
}

export function classifyStreamStop(opts: {
  hasEndMarker: boolean
  fromUiStopButton?: boolean
}): StreamStopKind {
  if (opts.fromUiStopButton) return 'ui_stop'
  if (opts.hasEndMarker) return 'normal'
  return 'abnormal'
}

function dedupeKey(sessionKey: string, runId: string): string {
  return `${sessionKey || '_'}::${runId || '_'}`
}

function shouldSkip(key: string, kind: StreamStopKind): boolean {
  const now = Date.now()
  const prev = recentStops.get(key)
  if (!prev || now - prev.at > DEDUPE_MS) return false
  if (prev.kind === 'abnormal') return true
  if (kind === 'abnormal') return false
  return true
}

function remember(key: string, kind: StreamStopKind, trigger: string): void {
  recentStops.set(key, { at: Date.now(), kind, trigger })
  if (recentStops.size > 80) {
    const cutoff = Date.now() - DEDUPE_MS * 2
    for (const [k, v] of recentStops) {
      if (v.at < cutoff) recentStops.delete(k)
    }
  }
}

function pushRing(rec: StreamStopRecord): void {
  ring.push(rec)
  while (ring.length > RING_MAX) ring.shift()
  try {
    if (typeof window !== 'undefined') {
      ;(window as Window & { __evoflowStreamStops?: StreamStopRecord[] }).__evoflowStreamStops = [
        ...ring,
      ]
    }
  } catch {
    /* ignore */
  }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LS_RING_KEY, JSON.stringify(ring.slice(-40)))
    }
  } catch {
    /* quota / private mode */
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function persistToFrontendLog(level: 'info' | 'warn' | 'error', line: string, payload: unknown): void {
  try {
    if (typeof window === 'undefined') return
    const w = window as Window & {
      __TAURI__?: { core?: { invoke?: unknown } }
      __TAURI_INTERNALS__?: unknown
    }
    const hasTauri = !!(w.__TAURI__?.core?.invoke || w.__TAURI_INTERNALS__)
    if (!hasTauri) return
    const message = `${line} ${safeJson(payload)}`.slice(0, 11_500)
    void import('@tauri-apps/api/core')
      .then((m) => m.invoke('append_frontend_log', { level, message }))
      .catch(() => {})
  } catch {
    /* best-effort */
  }
}

function hydrateRingFromStorage(): void {
  try {
    if (typeof localStorage === 'undefined') return
    const raw = localStorage.getItem(LS_RING_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as StreamStopRecord[]
    if (!Array.isArray(parsed) || !parsed.length) return
    for (const row of parsed.slice(-RING_MAX)) {
      if (row && typeof row === 'object' && row.trigger) ring.push(row)
    }
    if (typeof window !== 'undefined') {
      ;(window as Window & { __evoflowStreamStops?: StreamStopRecord[] }).__evoflowStreamStops = [
        ...ring,
      ]
    }
  } catch {
    /* ignore */
  }
}

let hydrated = false
function ensureHydrated(): void {
  if (hydrated) return
  hydrated = true
  hydrateRingFromStorage()
}

/** 新一轮发送时清掉该会话的去重，避免误吞后续停止日志 */
export function resetStreamStopLogDedupe(sessionKey?: string | null): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) {
    recentStops.clear()
    return
  }
  const prefix = `${sk}::`
  for (const k of [...recentStops.keys()]) {
    if (k.startsWith(prefix)) recentStops.delete(k)
  }
}

export function getStreamStopRing(): StreamStopRecord[] {
  ensureHydrated()
  return [...ring]
}

export function logStreamStop(input: StreamStopLogInput): StreamStopKind {
  ensureHydrated()
  const sessionKey = String(input.sessionKey || '').trim()
  const runId = String(input.runId || '').trim()
  const trigger = String(input.trigger || input.reason || 'unknown').trim() || 'unknown'
  const hasEndMarker = !!input.hasEndMarker
  const fromUiStopButton = !!(input.fromUiStopButton ?? input.userInitiated)
  const kind = classifyStreamStop({ hasEndMarker, fromUiStopButton })

  if (!enabled()) return kind

  const key = dedupeKey(sessionKey, runId)
  if (shouldSkip(key, kind)) return kind
  remember(key, kind, trigger)

  const ctx = pageContext()
  const rec: StreamStopRecord = {
    at: new Date().toISOString(),
    atMs: Date.now(),
    kind,
    trigger,
    hasEndMarker,
    fromUiStopButton,
    sessionKey: sessionKey || undefined,
    runId: runId || undefined,
    ...ctx,
    ...(input.detail && Object.keys(input.detail).length ? { detail: input.detail } : {}),
  }
  pushRing(rec)

  const payload = {
    kind: rec.kind,
    trigger: rec.trigger,
    hasEndMarker: rec.hasEndMarker,
    fromUiStopButton: rec.fromUiStopButton,
    note:
      rec.kind === 'ui_stop'
        ? '仅表示走了停止按钮代码路径；无法区分误触/故意。刷新/超时不会标成 ui_stop'
        : undefined,
    sessionKey: rec.sessionKey,
    runId: rec.runId,
    href: rec.href,
    visibility: rec.visibility,
    ...(rec.detail ? { detail: rec.detail } : {}),
  }

  const line = `${PREFIX} ${kind} trigger=${trigger} hasEndMarker=${hasEndMarker}`
  if (kind === 'abnormal') {
    console.error(line, payload)
    persistToFrontendLog('error', line, payload)
  } else {
    console.info(line, payload)
    persistToFrontendLog('info', line, payload)
  }
  return kind
}

/**
 * 页面刷新/关闭时：若仍有 busy 会话，记一条 page_unload。
 * 刷新后靠落盘 / localStorage ring 排查。
 */
export function installStreamStopPageUnloadHook(listBusyKeys: () => string[]): () => void {
  if (typeof window === 'undefined') return () => {}
  const onUnload = () => {
    let keys: string[] = []
    try {
      keys = listBusyKeys()
        .map((k) => String(k || '').trim())
        .filter(Boolean)
    } catch {
      return
    }
    if (!keys.length) return
    for (const sk of keys) {
      logStreamStop({
        sessionKey: sk,
        trigger: 'page_unload',
        hasEndMarker: false,
        detail: {
          event: 'pagehide_or_beforeunload',
          note: '页面卸载时会话仍 busy；刷新后看 frontend-*.log 或 localStorage EVOFLOW_STREAM_STOP_RING',
        },
      })
    }
  }
  window.addEventListener('pagehide', onUnload)
  window.addEventListener('beforeunload', onUnload)
  return () => {
    window.removeEventListener('pagehide', onUnload)
    window.removeEventListener('beforeunload', onUnload)
  }
}
