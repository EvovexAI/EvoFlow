/**
 * 对话回合生命周期日志（点发送 → 上线 → RUN_STARTED → 首帧 → 流结束）。
 *
 * ## 落点
 * 1. DevTools Console：过滤 `[回合计时]` 或 `[turn-lifecycle]`
 * 2. 桌面端专属：`~/.evoflow/logs/chat-turn-lifecycle-YYYY-MM-DD.log`（保留 7 天）
 * 3. 仍镜像一份到 `frontend-YYYY-MM-DD.log`（兼容旧 grep）
 * 4. 系统日志页 → Turn lifecycle
 * 5. 异常环：`listChatTurnAnomalies()` / `window.__evoflowTurnAnomalies`
 *    （久等无首字会按阶段「记死」，统一事后排查 FE vs BE）
 *
 * 关闭：localStorage.setItem('EVOFLOW_TURN_TIMING_LOG', '0')
 *
 * 慢首帧拆解：看 sinceSendMs 在
 * send_click → send_wire → run_started → first_response → stream_end 之间的差。
 *
 * 正常判定：点击发送 → 页面出现首个回复字（first_response）→ 流正常收口（stream_end）。
 * 任一环卡住超过阈值 → `first_token_stall` / `first_token_dead` 写入异常环 + 生命周期日志。
 */
import { logChatRuntimeTurn, logChatRuntimeUserClick } from './chat-runtime-log.js'

const PREFIX = '[回合计时]'
const LC_PREFIX = '[turn-lifecycle]'
const LS_ENABLE_KEY = 'EVOFLOW_TURN_TIMING_LOG'
const SLOW_FIRST_MS = 3_000
const SEND_CLICK_BIND_MS = 12_000

/** 首字看门狗阈值：5s 预警 / 12s 再警 / 30s 记死（error） */
const FIRST_TOKEN_STALL_STEPS: Array<{
  ms: number
  level: 'warn' | 'error'
  dead: boolean
}> = [
  { ms: 5_000, level: 'warn', dead: false },
  { ms: 12_000, level: 'warn', dead: false },
  { ms: 30_000, level: 'error', dead: true },
]

export type ChatTurnStallStage =
  | 'fe_prep'
  | 'be_accept'
  | 'await_first_token'
  | 'await_stream_end'
  | 'unknown'

export type ChatTurnAnomaly = {
  id: string
  at: number
  sessionKey: string
  event: 'first_token_stall' | 'first_token_dead' | 'stream_end_missing'
  stage: ChatTurnStallStage
  sinceSendMs: number
  wireLogged: boolean
  runStartedLogged: boolean
  firstResponseLogged: boolean
  textPreview: string
  zh: string
  runId?: string
}

const ANOMALY_RING_MAX = 80
const anomalyRing: ChatTurnAnomaly[] = []
const anomalyListeners = new Set<(a: ChatTurnAnomaly) => void>()
let stallWatchTimer: ReturnType<typeof setInterval> | null = null
/** 本轮已打过的首字阈值（ms），避免重复刷 */
const stallStepsFired = new Set<number>()
let streamEndWatchTimer: ReturnType<typeof setTimeout> | null = null
const STREAM_END_DEAD_MS = 5 * 60_000

export type ChatTurnSendTrace = {
  sessionKey: string
  startedAt: number
  textPreview: string
  attachmentCount: number
  /** 中文「点击发送」是否已落盘（避免 Composer + handle-send 双记） */
  sendClickLogged?: boolean
  firstResponseLogged?: boolean
  wireLogged?: boolean
  runStartedLogged?: boolean
  streamEndLogged?: boolean
  runId?: string
}

let sendTrace: ChatTurnSendTrace | null = null
/**
 * 上一轮已点发送/上线、但还没等到首帧时被新一轮 send_click 顶掉的快照。
 * Composer 会先 logChatTurnSendClick 重置 sendTrace；卡顿重发必须读这份，不能读新 trace。
 */
let unansweredPriorTrace: ChatTurnSendTrace | null = null
/** 同一会话状态卡展示去重，避免 effect 连打 */
const summaryShownRecent = new Map<string, number>()
const SUMMARY_DEDUPE_MS = 1_500

/**
 * 首帧响应幂等闩（与 sendTrace 解耦）：后台/主动任务回合没有本窗点击锚点，
 * sendTrace 守卫全部旁路 → 每个 TEXT/REASONING delta 都会走 emit（console + 双 IPC 落盘）。
 * 实测 2026-11-14 单日 11,750 条「首帧响应」，峰值 57 条/s——流式全程都在给主线程
 * 叠 JSON.stringify + 动态 import + invoke 的税，是「面板半死」的常驻贡献项。
 * 按 session|run 只放行每个回合的首个 chunk；RUN_STARTED 时清该会话旧闩。
 */
const firstResponseLatched = new Map<string, number>()
const FIRST_RESPONSE_LATCH_MAX = 64
const FIRST_RESPONSE_LATCH_TTL_MS = 10 * 60_000

/** 新回合开始：清掉该会话的全部旧闩（runId 缺失的 delta 也只记首个）。 */
function resetFirstResponseLatch(sessionKey?: string | null): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  const prefix = `${sk}|`
  for (const key of firstResponseLatched.keys()) {
    if (key.startsWith(prefix) || key === `${sk}|`) firstResponseLatched.delete(key)
  }
}

/** 消费一次闩：返回 true 表示该 chunk 已被幂等拦截，不再落盘。
 *  runId 存在时同时占 `sk|runId` 与 `sk|-` 两键——同回合 delta 的 runId 忽有忽无
 *  （不同事件类型携带不一致）也不会把第二个 chunk 放出去。 */
function claimFirstResponseLatch(sessionKey?: string, runId?: string): boolean {
  const sk = sessionKey || '-'
  const keys = runId ? [`${sk}|${runId}`, `${sk}|`] : [`${sk}|`]
  const now = Date.now()
  const isFresh = (t: number | undefined) => t != null && now - t < FIRST_RESPONSE_LATCH_TTL_MS
  if (keys.some((k) => isFresh(firstResponseLatched.get(k)))) return true
  for (const key of keys) firstResponseLatched.set(key, now)
  if (firstResponseLatched.size > FIRST_RESPONSE_LATCH_MAX) {
    // 容量兜底：淘汰最早的一条，防长驻会话无限堆积
    let oldestKey = ''
    let oldestAt = Infinity
    for (const [k, t] of firstResponseLatched) {
      if (t < oldestAt) {
        oldestAt = t
        oldestKey = k
      }
    }
    if (oldestKey) firstResponseLatched.delete(oldestKey)
  }
  return false
}

function archiveUnansweredSendTrace(): void {
  if (!sendTrace) return
  if (sendTrace.firstResponseLogged) return
  if (!sendTrace.sendClickLogged && !sendTrace.wireLogged) return
  unansweredPriorTrace = { ...sendTrace }
}

function clearUnansweredIfMatched(sessionKey?: string | null): void {
  if (!unansweredPriorTrace) return
  const sk = String(sessionKey || '').trim()
  if (sk && unansweredPriorTrace.sessionKey && sk !== unansweredPriorTrace.sessionKey) return
  unansweredPriorTrace = null
}

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

function clipText(raw: unknown, max = 200): string {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  if (s.length <= max) return s
  return `${s.slice(0, max)}…(+${s.length - max})`
}

/** 语音转写常夹杂「呃/啊」等，绑定时忽略这些差异 */
function normalizeSendText(raw: unknown): string {
  return clipText(raw, 240)
    .replace(/[呃啊嗯哦唔欸诶]+/g, '')
    .replace(/\s+/g, '')
}

function hasTauriInvoke(): boolean {
  try {
    if (typeof window === 'undefined') return false
    const w = window as Window & {
      __TAURI__?: { core?: { invoke?: unknown } }
      __TAURI_INTERNALS__?: unknown
    }
    return !!(w.__TAURI__?.core?.invoke || w.__TAURI_INTERNALS__)
  } catch {
    return false
  }
}

function persistToFrontendLog(level: 'info' | 'warn' | 'error', line: string): void {
  try {
    if (!hasTauriInvoke()) return
    void import('@tauri-apps/api/core')
      .then((m) => m.invoke('append_frontend_log', { level, message: line.slice(0, 11_500) }))
      .catch(() => {})
  } catch {
    /* best-effort */
  }
}

/** 专属生命周期文件：不跟 frontend 巨文件搅在一起。 */
function persistToLifecycleLog(level: 'info' | 'warn' | 'error', line: string): void {
  try {
    if (!hasTauriInvoke()) return
    void import('@tauri-apps/api/core')
      .then((m) =>
        m.invoke('append_chat_turn_lifecycle_log', {
          level,
          message: line.slice(0, 15_500),
        }),
      )
      .catch(() => {})
  } catch {
    /* best-effort */
  }
}

function emit(
  zh: string,
  detail?: Record<string, unknown>,
  level: 'info' | 'warn' | 'error' = 'info',
): void {
  if (!enabled()) return
  const payload = {
    zh,
    at: new Date().toISOString(),
    atMs: Date.now(),
    ...(detail || {}),
  }
  const line = `${PREFIX} ${zh}`
  const lcLine = `${LC_PREFIX} ${zh}`
  if (level === 'error') console.error(line, payload)
  else if (level === 'warn') console.warn(line, payload)
  else console.info(line, payload)
  const body = `${safeJson(payload)}`
  persistToFrontendLog(level, `${line} ${body}`)
  persistToLifecycleLog(level, `${lcLine} ${body}`)
}

function classifyStallStage(trace: ChatTurnSendTrace): ChatTurnStallStage {
  if (!trace.wireLogged) return 'fe_prep'
  if (!trace.runStartedLogged) return 'be_accept'
  if (!trace.firstResponseLogged) return 'await_first_token'
  if (!trace.streamEndLogged) return 'await_stream_end'
  return 'unknown'
}

function stageZh(stage: ChatTurnStallStage): string {
  switch (stage) {
    case 'fe_prep':
      return '前端发送准备（paint/context/abort/上线前）'
    case 'be_accept':
      return '已上线、等服务端 RUN_STARTED（网关/LangGraph 受理）'
    case 'await_first_token':
      return '回合已开跑、等首字（模型/推理首 token）'
    case 'await_stream_end':
      return '已有首字、等整轮收口'
    default:
      return '未知阶段'
  }
}

function pushAnomaly(a: ChatTurnAnomaly): void {
  anomalyRing.push(a)
  while (anomalyRing.length > ANOMALY_RING_MAX) anomalyRing.shift()
  for (const fn of anomalyListeners) {
    try {
      fn(a)
    } catch {
      /* ignore */
    }
  }
  try {
    const w = window as Window & { __evoflowTurnAnomalies?: unknown }
    w.__evoflowTurnAnomalies = {
      list: listChatTurnAnomalies,
      latest: getLatestChatTurnAnomaly,
      activeStall: getActiveChatTurnStall,
    }
  } catch {
    /* ignore */
  }
}

export function listChatTurnAnomalies(): ChatTurnAnomaly[] {
  return anomalyRing.slice()
}

export function getLatestChatTurnAnomaly(
  sessionKey?: string | null,
): ChatTurnAnomaly | null {
  const sk = String(sessionKey || '').trim()
  for (let i = anomalyRing.length - 1; i >= 0; i -= 1) {
    const a = anomalyRing[i]
    if (!sk || a.sessionKey === sk) return a
  }
  return null
}

/** 当前仍在等首字的活跃卡顿（有 sendTrace 且未首帧） */
export function getActiveChatTurnStall(
  sessionKey?: string | null,
): {
  stalled: boolean
  sinceMs: number
  stage: ChatTurnStallStage
  stageLabel: string
  zh: string
} | null {
  if (!sendTrace || sendTrace.firstResponseLogged) return null
  if (!sendTrace.sendClickLogged && !sendTrace.wireLogged) return null
  const sk = String(sessionKey || '').trim()
  if (sk && sendTrace.sessionKey && sk !== sendTrace.sessionKey) return null
  const since = Math.max(0, Date.now() - sendTrace.startedAt)
  if (since < FIRST_TOKEN_STALL_STEPS[0].ms) return null
  const stage = classifyStallStage(sendTrace)
  return {
    stalled: true,
    sinceMs: since,
    stage,
    stageLabel: stageZh(stage),
    zh: `等首字已 ${since}ms · ${stageZh(stage)}`,
  }
}

export function subscribeChatTurnAnomalies(
  fn: (a: ChatTurnAnomaly) => void,
): () => void {
  anomalyListeners.add(fn)
  return () => {
    anomalyListeners.delete(fn)
  }
}

function stopFirstTokenWatch(): void {
  if (stallWatchTimer != null) {
    clearInterval(stallWatchTimer)
    stallWatchTimer = null
  }
  stallStepsFired.clear()
}

function stopStreamEndWatch(): void {
  if (streamEndWatchTimer != null) {
    clearTimeout(streamEndWatchTimer)
    streamEndWatchTimer = null
  }
}

function recordFirstTokenStall(opts: {
  dead: boolean
  level: 'warn' | 'error'
  sinceMs: number
}): void {
  if (!sendTrace) return
  if (sendTrace.firstResponseLogged) return
  const stage = classifyStallStage(sendTrace)
  const event = opts.dead ? 'first_token_dead' : 'first_token_stall'
  const zh = opts.dead
    ? `首字超时记死：已等 ${opts.sinceMs}ms 仍无回复字 · 卡在「${stageZh(stage)}」——请对照 Turn lifecycle 查 FE/BE`
    : `首字偏慢预警：已等 ${opts.sinceMs}ms · 卡在「${stageZh(stage)}」`
  emit(
    zh,
    {
      event,
      stage,
      stageLabel: stageZh(stage),
      sessionKey: sendTrace.sessionKey || undefined,
      runId: sendTrace.runId || undefined,
      sinceSendMs: opts.sinceMs,
      wireLogged: !!sendTrace.wireLogged,
      runStartedLogged: !!sendTrace.runStartedLogged,
      firstResponseLogged: false,
      textPreview: sendTrace.textPreview || undefined,
      dead: opts.dead,
    },
    opts.level,
  )
  pushAnomaly({
    id: `${event}-${sendTrace.startedAt}-${opts.sinceMs}`,
    at: Date.now(),
    sessionKey: sendTrace.sessionKey || '',
    event,
    stage,
    sinceSendMs: opts.sinceMs,
    wireLogged: !!sendTrace.wireLogged,
    runStartedLogged: !!sendTrace.runStartedLogged,
    firstResponseLogged: false,
    textPreview: sendTrace.textPreview || '',
    zh,
    runId: sendTrace.runId,
  })
}

/** 点发送后启动：定时检查是否出现首字；超时写入异常环。 */
function armFirstTokenWatch(): void {
  stopFirstTokenWatch()
  stopStreamEndWatch()
  if (typeof window === 'undefined') return
  stallWatchTimer = setInterval(() => {
    if (!sendTrace || sendTrace.firstResponseLogged) {
      stopFirstTokenWatch()
      return
    }
    if (!sendTrace.sendClickLogged && !sendTrace.wireLogged) return
    const since = Math.max(0, Date.now() - sendTrace.startedAt)
    for (const step of FIRST_TOKEN_STALL_STEPS) {
      if (since < step.ms || stallStepsFired.has(step.ms)) continue
      stallStepsFired.add(step.ms)
      recordFirstTokenStall({ dead: step.dead, level: step.level, sinceMs: since })
      if (step.dead) {
        // 记死后仍留 watch，直到首字/结束，便于后续若突然回来能对上 first_response
        break
      }
    }
  }, 1000)
}

function armStreamEndWatch(): void {
  stopStreamEndWatch()
  if (typeof window === 'undefined' || !sendTrace) return
  const startedAt = sendTrace.startedAt
  const sessionKey = sendTrace.sessionKey
  streamEndWatchTimer = setTimeout(() => {
    streamEndWatchTimer = null
    if (!sendTrace || sendTrace.startedAt !== startedAt) return
    if (sendTrace.streamEndLogged || !sendTrace.firstResponseLogged) return
    const since = Math.max(0, Date.now() - sendTrace.startedAt)
    const zh = `整轮未收口：已有首字但 ${since}ms 仍无 stream_end · 可能挂死或只停了 UI busy`
    emit(
      zh,
      {
        event: 'stream_end_missing',
        stage: 'await_stream_end',
        sessionKey: sendTrace.sessionKey || sessionKey || undefined,
        runId: sendTrace.runId || undefined,
        sinceSendMs: since,
        wireLogged: true,
        runStartedLogged: true,
        firstResponseLogged: true,
      },
      'error',
    )
    pushAnomaly({
      id: `stream_end_missing-${startedAt}`,
      at: Date.now(),
      sessionKey: sendTrace.sessionKey || sessionKey || '',
      event: 'stream_end_missing',
      stage: 'await_stream_end',
      sinceSendMs: since,
      wireLogged: true,
      runStartedLogged: true,
      firstResponseLogged: true,
      textPreview: sendTrace.textPreview || '',
      zh,
      runId: sendTrace.runId,
    })
  }, STREAM_END_DEAD_MS)
}

/**
 * 把 Composer 已记下的发送锚点绑到 sessionKey（保留点击时刻）。
 * 若无近期 Composer 点击，则新建锚点。返回是否已有「点击发送」中文日志。
 */
export function bindChatTurnSendSession(opts: {
  sessionKey?: string | null
  text?: string | null
  attachmentCount?: number
}): { sendClickAlreadyLogged: boolean } {
  const sessionKey = String(opts.sessionKey || '').trim()
  const textPreview = clipText(opts.text, 240)
  const attachmentCount = Math.max(0, Number(opts.attachmentCount) || 0)
  const norm = normalizeSendText(textPreview)
  const canBind =
    !!sendTrace &&
    Date.now() - sendTrace.startedAt < SEND_CLICK_BIND_MS &&
    (!norm ||
      !sendTrace.textPreview ||
      normalizeSendText(sendTrace.textPreview) === norm ||
      normalizeSendText(sendTrace.textPreview).includes(norm) ||
      norm.includes(normalizeSendText(sendTrace.textPreview)))
  if (canBind && sendTrace) {
    // 只补绑 sessionKey，保留点击 startedAt；勿清 firstResponseLogged
    sendTrace = {
      ...sendTrace,
      sessionKey: sessionKey || sendTrace.sessionKey,
      textPreview: textPreview || sendTrace.textPreview,
      attachmentCount: attachmentCount || sendTrace.attachmentCount,
    }
    return { sendClickAlreadyLogged: !!sendTrace.sendClickLogged }
  }
  archiveUnansweredSendTrace()
  sendTrace = {
    sessionKey,
    startedAt: Date.now(),
    textPreview,
    attachmentCount,
    sendClickLogged: false,
    firstResponseLogged: false,
    wireLogged: false,
    runStartedLogged: false,
  }
  return { sendClickAlreadyLogged: false }
}

export function chatTurnSinceSendMs(sessionKey?: string | null): number | null {
  if (!sendTrace) return null
  const sk = String(sessionKey || '').trim()
  // Composer 点击时尚无 sessionKey 时 sendTrace.sessionKey 为空：允许用后续 sk 算耗时
  if (sk && sendTrace.sessionKey && sk !== sendTrace.sessionKey) return null
  return Math.max(0, Date.now() - sendTrace.startedAt)
}

/** 上一轮已上线但还没等到首帧时，用户又点发送——用于 toast / 日志，避免「连发像死机」。 */
export function describeStalledPriorSend(sessionKey?: string | null): {
  stalled: boolean
  sinceMs: number | null
  textPreview: string
  wireLogged: boolean
  runStartedLogged: boolean
} {
  const empty = {
    stalled: false,
    sinceMs: null as number | null,
    textPreview: '',
    wireLogged: false,
    runStartedLogged: false,
  }
  const sk = String(sessionKey || '').trim()
  // 优先读被新一轮 send_click 顶掉的快照；否则读当前仍未首帧的 sendTrace（bind 前快照）。
  const prior =
    unansweredPriorTrace &&
    (!sk || !unansweredPriorTrace.sessionKey || sk === unansweredPriorTrace.sessionKey)
      ? unansweredPriorTrace
      : sendTrace &&
          !sendTrace.firstResponseLogged &&
          (!sk || !sendTrace.sessionKey || sk === sendTrace.sessionKey)
        ? sendTrace
        : null
  if (!prior || prior.firstResponseLogged) return empty
  if (!prior.sendClickLogged && !prior.wireLogged) return empty
  const since = Math.max(0, Date.now() - prior.startedAt)
  // 太短不算卡住（paint/wire 本来就要几百毫秒）；太久也不提示（用户可能已停很久）
  if (since < 5_000 || since > 10 * 60_000) return empty
  return {
    stalled: true,
    sinceMs: since,
    textPreview: prior.textPreview || '',
    wireLogged: !!prior.wireLogged,
    runStartedLogged: !!prior.runStartedLogged,
  }
}

/** 卡住重发诊断：进 frontend-*.log，和 send_click / first_response 同一通道。 */
export function logChatTurnStalledResend(opts: {
  sessionKey?: string | null
  sinceMs?: number | null
  priorPreview?: string | null
  wireLogged?: boolean
  runStartedLogged?: boolean
}): void {
  const sessionKey = String(opts.sessionKey || '').trim()
  const since = opts.sinceMs != null ? Math.max(0, Number(opts.sinceMs) || 0) : null
  const prior = clipText(opts.priorPreview, 120)
  emit(
    `卡住重发：上一轮${since != null ? `已等 ${since}ms` : ''}仍无首帧，已打断并改发${prior ? `（上一条「${prior}」）` : ''}`,
    {
      event: 'stalled_resend',
      sessionKey: sessionKey || undefined,
      ...(since != null ? { sinceMs: since } : {}),
      priorPreview: prior || undefined,
      wireLogged: opts.wireLogged ?? undefined,
      runStartedLogged: opts.runStartedLogged ?? undefined,
    },
    'warn',
  )
}

/**
 * ① 点击发送按钮 / 实际发起发送：时间 + 发送内容。
 * Composer 先记；handle-send 仅在尚未记过时补记（目标/语音等入口）。
 */
export function logChatTurnSendClick(opts: {
  sessionKey?: string | null
  text?: string | null
  attachmentCount?: number
  source?: string
}): void {
  const textPreview = clipText(opts.text, 240)
  const attachmentCount = Math.max(0, Number(opts.attachmentCount) || 0)
  const sessionKey = String(opts.sessionKey || '').trim()
  archiveUnansweredSendTrace()
  sendTrace = {
    sessionKey: sessionKey || sendTrace?.sessionKey || '',
    startedAt: Date.now(),
    textPreview,
    attachmentCount,
    sendClickLogged: true,
    firstResponseLogged: false,
    wireLogged: false,
    runStartedLogged: false,
    streamEndLogged: false,
    runId: undefined,
  }
  const contentDesc = textPreview
    ? `内容「${textPreview}」`
    : attachmentCount > 0
      ? '（仅附件，无正文）'
      : '（空内容）'
  const attachDesc = attachmentCount > 0 ? `，附件 ${attachmentCount} 个` : ''
  emit(`点击发送：${contentDesc}${attachDesc}`, {
    event: 'send_click',
    sessionKey: sessionKey || undefined,
    textPreview: textPreview || undefined,
    attachmentCount,
    source: opts.source || undefined,
  })
  const queued = String(opts.source || '').includes('queue')
  logChatRuntimeUserClick({
    action: queued ? 'queue_while_busy' : 'send',
    whoZh: queued
      ? `用户在仍 busy 时点发送（排队）：${contentDesc}`
      : `用户点击发送：${contentDesc}`,
    sessionKey: sessionKey || undefined,
    textPreview,
    detail: { attachmentCount, source: opts.source || undefined },
  })
  if (!queued) {
    logChatRuntimeTurn({
      phase: 'start',
      whoZh: `对话回合开始（点击发送）：${contentDesc}`,
      sessionKey: sessionKey || undefined,
      detail: { attachmentCount, source: opts.source || undefined },
    })
    armFirstTokenWatch()
  }
}

/** chatSend 真正发出（已过 context/abort 准备）：看「点发送→上线」卡了多久 */
export function logChatTurnSendWire(opts: {
  sessionKey?: string | null
  runId?: string | null
}): void {
  if (!sendTrace || sendTrace.wireLogged) return
  const sessionKey = String(opts.sessionKey || '').trim()
  if (sessionKey && sendTrace.sessionKey && sessionKey !== sendTrace.sessionKey) return
  if (sessionKey && !sendTrace.sessionKey) sendTrace.sessionKey = sessionKey
  sendTrace.wireLogged = true
  const since = chatTurnSinceSendMs(sessionKey || sendTrace.sessionKey)
  const sinceDesc = since != null ? `距点击 ${since}ms` : '无点击锚点'
  const level = since != null && since >= SLOW_FIRST_MS ? 'warn' : 'info'
  emit(
    `消息已上线（chatSend）：${sinceDesc}${since != null && since >= SLOW_FIRST_MS ? ' —— 发送准备偏慢（paint/context/abort/beforeWire）' : ''}`,
    {
      event: 'send_wire',
      sessionKey: sessionKey || sendTrace.sessionKey || undefined,
      runId: String(opts.runId || '').trim() || undefined,
      ...(since != null ? { sinceSendMs: since } : {}),
    },
    level,
  )
  // 目标/语音等未走 Composer 点击时，上线瞬间补启看门狗
  if (!stallWatchTimer) armFirstTokenWatch()
}

/** AG-UI RUN_STARTED：服务端开始跑本轮 */
export function logChatTurnRunStarted(opts: {
  sessionKey?: string | null
  runId?: string | null
}): void {
  const sessionKey = String(opts.sessionKey || '').trim()
  // 新回合开始先清首帧闩。必须在 sendTrace 守卫之前：后台回合 sendTrace 为 null
  // 会提前 return，闩若不清，该会话下一轮的首帧会被上一轮的 key 拦到 TTL 过期。
  resetFirstResponseLatch(sessionKey)
  if (!sendTrace || sendTrace.runStartedLogged) return
  if (sessionKey && sendTrace.sessionKey && sessionKey !== sendTrace.sessionKey) return
  if (sessionKey && !sendTrace.sessionKey) sendTrace.sessionKey = sessionKey
  sendTrace.runStartedLogged = true
  const runId = String(opts.runId || '').trim()
  if (runId) sendTrace.runId = runId
  const since = chatTurnSinceSendMs(sessionKey || sendTrace.sessionKey)
  const sinceDesc = since != null ? `距点击 ${since}ms` : '无点击锚点'
  const level = since != null && since >= SLOW_FIRST_MS ? 'warn' : 'info'
  emit(
    `回合已开始（RUN_STARTED）：${sinceDesc}${since != null && since >= SLOW_FIRST_MS ? ' —— 等服务端开跑偏慢' : ''}`,
    {
      event: 'run_started',
      sessionKey: sessionKey || sendTrace.sessionKey || undefined,
      runId: runId || undefined,
      ...(since != null ? { sinceSendMs: since } : {}),
    },
    level,
  )
}

/**
 * ② 对话右上角状态卡（ChatSummary）展开/展示：时间 + 展示内容摘要。
 */
export function logChatSummaryPanelShown(opts: {
  sessionKey?: string | null
  mode?: string | null
  tab?: string | null
  agentLabel?: string | null
  modelLabel?: string | null
  sessionTitle?: string | null
  runningCount?: number | null
  processCount?: number | null
  artifactCount?: number | null
  platformCount?: number | null
  reason?: string | null
  contentPreview?: string | null
}): void {
  const sessionKey = String(opts.sessionKey || '').trim()
  const dedupeKey = `${sessionKey}|${opts.mode || ''}|${opts.tab || ''}|${opts.reason || ''}`
  const now = Date.now()
  const last = summaryShownRecent.get(dedupeKey)
  if (last != null && now - last < SUMMARY_DEDUPE_MS) return
  summaryShownRecent.set(dedupeKey, now)
  if (summaryShownRecent.size > 80) {
    for (const [k, t] of summaryShownRecent) {
      if (now - t > SUMMARY_DEDUPE_MS * 4) summaryShownRecent.delete(k)
    }
  }

  const parts: string[] = []
  const agent = String(opts.agentLabel || '').trim()
  const model = String(opts.modelLabel || '').trim()
  const title = String(opts.sessionTitle || '').trim()
  const tab = String(opts.tab || '').trim()
  const mode = String(opts.mode || '').trim() || 'panel'
  if (agent) parts.push(`智能体「${agent}」`)
  if (model) parts.push(`模型「${model}」`)
  if (title) parts.push(`标题「${clipText(title, 80)}」`)
  if (tab) parts.push(`当前 tab「${tab}」`)
  if (opts.runningCount != null && opts.runningCount > 0) {
    parts.push(`运行中 ${opts.runningCount}`)
  }
  if (opts.processCount != null && opts.processCount > 0) {
    parts.push(`进程 ${opts.processCount}`)
  }
  if (opts.artifactCount != null && opts.artifactCount > 0) {
    parts.push(`产物 ${opts.artifactCount}`)
  }
  if (opts.platformCount != null && opts.platformCount > 0) {
    parts.push(`平台 ${opts.platformCount}`)
  }
  const preview = clipText(opts.contentPreview, 160)
  if (preview) parts.push(`摘要「${preview}」`)
  const body = parts.length ? parts.join('，') : '（状态卡展开，暂无额外摘要）'
  const reason = String(opts.reason || '').trim()
  const since = chatTurnSinceSendMs(sessionKey)
  emit(`右上角状态卡显示（${mode}）${reason ? `，原因：${reason}` : ''}：${body}`, {
    event: 'summary_panel_shown',
    sessionKey: sessionKey || undefined,
    mode,
    tab: tab || undefined,
    agentLabel: agent || undefined,
    modelLabel: model || undefined,
    sessionTitle: title || undefined,
    runningCount: opts.runningCount ?? undefined,
    processCount: opts.processCount ?? undefined,
    artifactCount: opts.artifactCount ?? undefined,
    platformCount: opts.platformCount ?? undefined,
    reason: reason || undefined,
    contentPreview: preview || undefined,
    ...(since != null ? { sinceSendMs: since } : {}),
  })
}

export type ChatTurnFirstResponseKind = 'text' | 'reasoning' | 'tool' | 'other'

/**
 * ③ 首帧响应：距发送的毫秒 + 首段可见内容预览。
 * 同一轮发送只记一次。
 */
export function logChatTurnFirstResponse(opts: {
  sessionKey?: string | null
  kind: ChatTurnFirstResponseKind
  preview?: string | null
  eventType?: string | null
  runId?: string | null
  gatedByV4?: boolean
}): void {
  const sessionKey = String(opts.sessionKey || '').trim()
  const runId = String(opts.runId || sendTrace?.runId || '').trim()
  // 幂等闩先行：无 sendTrace 的后台回合（主动任务/其他窗发送）每个 delta 都会走到这里，
  // 必须按回合只放行首个 chunk（见 firstResponseLatched 注释）。
  if (claimFirstResponseLatch(sessionKey || undefined, runId || undefined)) return
  if (sendTrace) {
    if (sessionKey && sendTrace.sessionKey && sessionKey !== sendTrace.sessionKey) return
    sendTrace.firstResponseLogged = true
    if (sessionKey && !sendTrace.sessionKey) sendTrace.sessionKey = sessionKey
  }
  clearUnansweredIfMatched(sessionKey || sendTrace?.sessionKey)
  const since = chatTurnSinceSendMs(sessionKey || sendTrace?.sessionKey)
  const preview = clipText(opts.preview, 200)
  const kindLabel =
    opts.kind === 'text'
      ? '正文'
      : opts.kind === 'reasoning'
        ? '思考'
        : opts.kind === 'tool'
          ? '工具'
          : '其它'
  const previewDesc = preview ? `，内容预览「${preview}」` : ''
  const sinceDesc = since != null ? `，距发送 ${since}ms` : ''
  const gateDesc = opts.gatedByV4 ? '（V4 已闸显示热路径，仍记首包时刻）' : ''
  const slow =
    since != null && since >= SLOW_FIRST_MS
      ? ` —— 偏慢：对照 send_wire / run_started 拆「准备 / 等模型 / 首 token」`
      : ''
  const level = since != null && since >= SLOW_FIRST_MS ? 'warn' : 'info'
  if (runId && sendTrace && !sendTrace.runId) sendTrace.runId = runId
  emit(`首帧响应：类型=${kindLabel}${sinceDesc}${previewDesc}${gateDesc}${slow}`, {
    event: 'first_response',
    sessionKey: sessionKey || sendTrace?.sessionKey || undefined,
    kind: opts.kind,
    eventType: opts.eventType || undefined,
    runId: runId || undefined,
    preview: preview || undefined,
    gatedByV4: opts.gatedByV4 || undefined,
    ...(since != null ? { sinceSendMs: since } : {}),
  }, level)
  stopFirstTokenWatch()
  armStreamEndWatch()
}

export type ChatTurnStreamEndOutcome =
  | 'sse_final'
  | 'sse_aborted'
  | 'stream_error'
  | 'ui_stop'
  | 'other'

/**
 * ④ 流式结束：正常 final / 异常断流 / 用户点停。
 * 同一轮只记一次；关闭生命周期（stream_end）。
 */
export function logChatTurnStreamEnd(opts: {
  sessionKey?: string | null
  runId?: string | null
  outcome: ChatTurnStreamEndOutcome
  whoZh?: string | null
  trigger?: string | null
  hasEndMarker?: boolean
  detail?: Record<string, unknown>
}): void {
  const sessionKey = String(opts.sessionKey || '').trim()
  if (sendTrace) {
    if (sessionKey && sendTrace.sessionKey && sessionKey !== sendTrace.sessionKey) {
      // 无匹配 sendTrace 时仍记一条孤立结束，方便对账
    } else if (sendTrace.streamEndLogged) {
      return
    } else {
      sendTrace.streamEndLogged = true
      if (sessionKey && !sendTrace.sessionKey) sendTrace.sessionKey = sessionKey
    }
  }
  const since = chatTurnSinceSendMs(sessionKey || sendTrace?.sessionKey)
  const sinceDesc = since != null ? `，距发送 ${since}ms` : ''
  const outcome = opts.outcome
  const outcomeZh =
    outcome === 'sse_final'
      ? '正常结束（SSE final）'
      : outcome === 'sse_aborted'
        ? '异常断流（SSE aborted）'
        : outcome === 'stream_error'
          ? '流错误结束'
          : outcome === 'ui_stop'
            ? '用户停止'
            : '其它结束'
  const who = String(opts.whoZh || '').trim() || outcomeZh
  const trigger = String(opts.trigger || outcome).trim()
  const level =
    outcome === 'sse_final' ? 'info' : outcome === 'ui_stop' ? 'info' : 'warn'
  emit(`流式结束：${who}${sinceDesc}`, {
    event: 'stream_end',
    outcome,
    trigger,
    whoZh: who,
    hasEndMarker: !!opts.hasEndMarker,
    sessionKey: sessionKey || sendTrace?.sessionKey || undefined,
    runId: String(opts.runId || sendTrace?.runId || '').trim() || undefined,
    textPreview: sendTrace?.textPreview || undefined,
    ...(since != null ? { sinceSendMs: since } : {}),
    ...(opts.detail || {}),
  }, level)
  stopFirstTokenWatch()
  stopStreamEndWatch()
  // 结束后清本轮锚点，避免下一轮误绑 sinceSendMs
  if (sendTrace && sendTrace.streamEndLogged) {
    sendTrace = null
  }
  clearUnansweredIfMatched(sessionKey)
}
