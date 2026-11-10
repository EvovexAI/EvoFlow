/**
 * 对话流停止 / 结束诊断日志（默认开启）。
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
 * ## kind
 * - `normal`：协议正常结束（SSE final / AG-UI 终态）
 * - `ui_stop`：走了 stopSessionExecution / 用户侧主动停（看 trigger/whoZh 区分点停 vs 打断重发）
 * - `abnormal`：无结束标识且非主动停 → 「莫名其妙停掉」主查对象
 *
 * 每条必带 `whoZh`（人话：谁停的 / 正常结束 / 异常断流）。
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
   * 例：composer_stop_button / sse_final / sse_aborted / interrupt_flush_queue / page_unload
   */
  trigger?: string
  /** @deprecated 用 trigger；兼容旧调用 */
  reason?: string
  /** 是否收到协议结束标识（final / RUN_FINISHED / RUN_ERROR） */
  hasEndMarker: boolean
  /**
   * 走了 stopSessionExecution / 用户侧主动停路径时为 true。
   * 不等于「用户点了停止」——打断重发也会是 true；看 trigger/whoZh。
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
  whoZh: string
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

/** trigger → 人话「谁停的 / 怎么结束的」 */
const TRIGGER_WHO_ZH: Record<string, string> = {
  composer_stop_button: '用户点击 Composer 停止按钮',
  shell_sidebar_stop: '用户点击侧栏停止',
  v4_stop_button: '用户点击 V4 停止按钮',
  v4_escape: '用户按 Esc 停止',
  interrupt_send_steers: '打断重发·纠偏指令（非单纯点停）',
  interrupt_flush_queue: '打断重发·排队消息（非单纯点停）',
  page_load_stale_stop: '页面加载发现过期 run，自动停止',
  employee_process_pane: '员工进程面板停止按钮',
  unknown: '未标注来源的主动停止',
  // 兼容旧 trigger
  ui_stop_button: '主动停止（旧标签；未区分点停/打断重发）',
  sse_aborted_after_ui_stop: '主动停止后的 SSE abort 回声',
  user_interrupt_error: '后端报 user interrupt（通常紧随主动停止）',
  // 正常结束
  sse_final: '正常结束（SSE final）',
  agui_run_error: '正常终态·模型/运行错误（AG-UI RUN_ERROR）',
  agui_model_error_finished: '正常终态·模型错误收尾',
  // 异常 / 系统
  sse_aborted: '异常断流（非用户停止：断网/后端取消/超时等）',
  stream_error: '流错误结束',
  page_unload: '页面关闭/刷新时仍 busy',
  stale_sending_watchdog: '发送超时看门狗强制收尾（非用户点停）',
  stale_busy_poll_clear: '全局 busy 轮询清状态（非用户点停）',
  stale_turn_watchdog: '回合超时看门狗强制收尾',
  send_prep_abort_stale_stream: '新发送前清理旧 SSE wire（非用户点停）',
  refresh_backend_done: '刷新发现后端已结束，前端清 busy（非用户点停）',
}

export function resolveStreamStopWhoZh(
  trigger: string,
  opts?: { hasEndMarker?: boolean; fromUiStopButton?: boolean; detailWhoZh?: string },
): string {
  const fromDetail = String(opts?.detailWhoZh || '').trim()
  if (fromDetail) return fromDetail
  const mapped = TRIGGER_WHO_ZH[trigger]
  if (mapped) return mapped
  if (opts?.fromUiStopButton) return `主动停止（trigger=${trigger || 'unknown'}）`
  if (opts?.hasEndMarker) return `正常结束（trigger=${trigger || 'unknown'}）`
  return `异常结束（trigger=${trigger || 'unknown'}）`
}

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
  const detailWhoZh =
    input.detail && typeof input.detail.whoZh === 'string' ? input.detail.whoZh : undefined
  const whoZh = resolveStreamStopWhoZh(trigger, {
    hasEndMarker,
    fromUiStopButton,
    detailWhoZh,
  })

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
    whoZh,
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
    whoZh: rec.whoZh,
    trigger: rec.trigger,
    hasEndMarker: rec.hasEndMarker,
    fromUiStopButton: rec.fromUiStopButton,
    sessionKey: rec.sessionKey,
    runId: rec.runId,
    href: rec.href,
    visibility: rec.visibility,
    ...(rec.detail ? { detail: rec.detail } : {}),
  }

  // 人话放最前，方便 grep「谁停的」
  const line = `${PREFIX} ${kind} who=${whoZh} trigger=${trigger} hasEndMarker=${hasEndMarker}`
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
          whoZh: TRIGGER_WHO_ZH.page_unload,
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
