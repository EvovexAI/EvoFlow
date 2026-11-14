/**
 * 对话运行时专项日志（与 frontend-*.log 隔离）。
 *
 * ## 落点
 * 1. DevTools Console：过滤 `[chat-runtime]`
 * 2. 桌面端：`~/.evoflow/logs/chat-runtime-YYYY-MM-DD.log`（保留 7 天）
 * 3. 系统日志页 → Chat runtime
 *
 * 关闭：localStorage.setItem('EVOFLOW_CHAT_RUNTIME_LOG', '0')
 *
 * ## 用途
 * - 每个会话的开始 / 停止时刻
 * - 用户在对话相关 UI 上的点击（发送 / 停止 / 排队发送 / 切会话）
 * - 停止是正常收口还是 UI 仍 busy（左右齿轮分叉）
 * - 每条带 sessionKey / threadId / runId / 标题 / 日历日，便于对具体对话
 */

const PREFIX = '[chat-runtime]'
const LS_ENABLE_KEY = 'EVOFLOW_CHAT_RUNTIME_LOG'
const FORK_DEDUPE_MS = 1_200
const RING_MAX = 120
const LS_RING_KEY = 'EVOFLOW_CHAT_RUNTIME_RING'

export type ChatRuntimeBusySnap = {
  selectedTurnBusy?: boolean
  displayTurnBusy?: boolean
  timelineBusy?: boolean
  uiBusy?: boolean
  listExecuting?: boolean
  v4TimelineBusy?: boolean
  recoveryCooldown?: boolean
  uiTurnSettled?: boolean
  runStatus?: string | null
  turnPhase?: string | null
}

export type ChatRuntimeLogInput = {
  /** 机器可读事件名 */
  event: string
  /** 人话 */
  whoZh: string
  sessionKey?: string | null
  threadId?: string | null
  runId?: string | null
  /** 侧栏标题 / 会话展示名 */
  title?: string | null
  /** 会话日历日（YYYY-MM-DD）；缺省用本地今天 */
  date?: string | null
  level?: 'info' | 'warn' | 'error'
  detail?: Record<string, unknown>
  busy?: ChatRuntimeBusySnap
}

type RingEntry = {
  at: string
  event: string
  whoZh: string
  sessionKey?: string
  threadId?: string
  runId?: string
  title?: string
  date: string
  level: string
  detail?: Record<string, unknown>
  busy?: ChatRuntimeBusySnap
}

const ring: RingEntry[] = []
const forkRecent = new Map<string, number>()

function enabled(): boolean {
  try {
    if (typeof localStorage === 'undefined') return true
    return localStorage.getItem(LS_ENABLE_KEY) !== '0'
  } catch {
    return true
  }
}

function todayDate(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function clip(raw: unknown, max = 160): string {
  const s = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return ''
  if (s.length <= max) return s
  return `${s.slice(0, max)}…(+${s.length - max})`
}

function persistToDisk(level: string, line: string): void {
  try {
    if (typeof window === 'undefined') return
    const w = window as Window & {
      __TAURI__?: { core?: { invoke?: unknown } }
      __TAURI_INTERNALS__?: unknown
    }
    if (!(w.__TAURI__?.core?.invoke || w.__TAURI_INTERNALS__)) return
    void import('@tauri-apps/api/core')
      .then((m) =>
        m.invoke('append_chat_runtime_log', {
          level,
          message: line.slice(0, 15_500),
        }),
      )
      .catch(() => {})
  } catch {
    /* best-effort */
  }
}

function pushRing(entry: RingEntry): void {
  ring.push(entry)
  while (ring.length > RING_MAX) ring.shift()
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(LS_RING_KEY, JSON.stringify(ring.slice(-40)))
  } catch {
    /* ignore quota */
  }
  try {
    ;(window as Window & { __evoflowChatRuntime?: RingEntry[] }).__evoflowChatRuntime = ring
  } catch {
    /* ignore */
  }
}

function busyForkHint(busy?: ChatRuntimeBusySnap): string | null {
  if (!busy) return null
  const stopOn = !!(busy.displayTurnBusy || busy.uiBusy)
  const listOn = !!busy.listExecuting
  if (stopOn === listOn) return null
  if (stopOn && !listOn) return '分叉：右下角停止仍亮，左侧列表已灭'
  return '分叉：右下角停止已灭，左侧列表/齿轮仍亮'
}

/**
 * 写一条对话运行时日志（console + chat-runtime-*.log + 环形缓冲）。
 */
export function logChatRuntime(input: ChatRuntimeLogInput): void {
  if (!enabled()) return
  const sessionKey = String(input.sessionKey || '').trim() || undefined
  const threadId = String(input.threadId || '').trim() || undefined
  const runId = String(input.runId || '').trim() || undefined
  const title = clip(input.title || '', 80) || undefined
  const date = String(input.date || '').trim() || todayDate()
  const level = input.level || 'info'
  const event = String(input.event || 'unknown').trim() || 'unknown'
  const whoZh = String(input.whoZh || event).trim() || event
  const fork = busyForkHint(input.busy)
  const payload: Record<string, unknown> = {
    event,
    whoZh,
    date,
    ...(sessionKey ? { sessionKey } : {}),
    ...(threadId ? { threadId } : {}),
    ...(runId ? { runId } : {}),
    ...(title ? { title } : {}),
    ...(input.busy ? { busy: input.busy } : {}),
    ...(fork ? { fork } : {}),
    ...(input.detail || {}),
  }
  const line = `${PREFIX} ${event} who=${whoZh} sk=${sessionKey || '∅'} date=${date}${
    title ? ` title=「${title}」` : ''
  }${fork ? ` !!${fork}` : ''}`
  if (level === 'error') console.error(line, payload)
  else if (level === 'warn') console.warn(line, payload)
  else console.info(line, payload)
  persistToDisk(level, `${line} ${safeJson(payload)}`)
  pushRing({
    at: new Date().toISOString(),
    event,
    whoZh,
    sessionKey,
    threadId,
    runId,
    title,
    date,
    level,
    detail: input.detail,
    busy: input.busy,
  })
}

/** 用户对话相关点击 */
export function logChatRuntimeUserClick(opts: {
  action:
    | 'send'
    | 'stop'
    | 'queue_while_busy'
    | 'session_switch'
    | 'sidebar_stop'
    | 'interrupt_flush'
    | string
  whoZh: string
  sessionKey?: string | null
  threadId?: string | null
  runId?: string | null
  title?: string | null
  date?: string | null
  textPreview?: string | null
  busy?: ChatRuntimeBusySnap
  detail?: Record<string, unknown>
}): void {
  logChatRuntime({
    event: `user_click_${opts.action}`,
    whoZh: opts.whoZh,
    sessionKey: opts.sessionKey,
    threadId: opts.threadId,
    runId: opts.runId,
    title: opts.title,
    date: opts.date,
    busy: opts.busy,
    detail: {
      action: opts.action,
      textPreview: clip(opts.textPreview || '', 120) || undefined,
      ...(opts.detail || {}),
    },
  })
}

/** 回合开始 / 停止请求 / 停止收口 */
export function logChatRuntimeTurn(opts: {
  phase: 'start' | 'stop_requested' | 'stop_normal' | 'stop_ui_idle' | 'stop_stuck' | 'error'
  whoZh: string
  sessionKey?: string | null
  threadId?: string | null
  runId?: string | null
  title?: string | null
  date?: string | null
  busy?: ChatRuntimeBusySnap
  detail?: Record<string, unknown>
  level?: 'info' | 'warn' | 'error'
}): void {
  const level =
    opts.level ||
    (opts.phase === 'stop_stuck' || opts.phase === 'error' ? 'warn' : 'info')
  logChatRuntime({
    event: `turn_${opts.phase}`,
    whoZh: opts.whoZh,
    sessionKey: opts.sessionKey,
    threadId: opts.threadId,
    runId: opts.runId,
    title: opts.title,
    date: opts.date,
    busy: opts.busy,
    level,
    detail: opts.detail,
  })
}

/**
 * 左右 busy 分叉：右下角停止 vs 左侧列表 executing 不一致时落一条 warn。
 * 去重：同一 session + 同一分叉方向 1.2s 内只记一次。
 */
export function logChatRuntimeBusyFork(opts: {
  sessionKey?: string | null
  threadId?: string | null
  runId?: string | null
  title?: string | null
  date?: string | null
  busy: ChatRuntimeBusySnap
  detail?: Record<string, unknown>
}): void {
  const fork = busyForkHint(opts.busy)
  if (!fork) return
  const sk = String(opts.sessionKey || '').trim() || '∅'
  const key = `${sk}|${fork}`
  const now = Date.now()
  const prev = forkRecent.get(key) || 0
  if (now - prev < FORK_DEDUPE_MS) return
  forkRecent.set(key, now)
  logChatRuntime({
    event: 'busy_fork',
    whoZh: fork,
    sessionKey: opts.sessionKey,
    threadId: opts.threadId,
    runId: opts.runId,
    title: opts.title,
    date: opts.date,
    busy: opts.busy,
    level: 'warn',
    detail: {
      note: '右下角停止(displayTurnBusy/uiBusy) 与 左侧列表(listExecuting) 不是同一时刻同一结果——排查同源判断是否分叉',
      ...(opts.detail || {}),
    },
  })
}

export function getChatRuntimeRing(): readonly RingEntry[] {
  return ring
}
