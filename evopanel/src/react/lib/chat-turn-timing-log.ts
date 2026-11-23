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
import { persistViewportTap } from '../v4/v4-viewport-tap-persist.js'

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

/** 浮层「计时」表：发送 → 出泡 → 上线 → 首字 → 结束 */
export type ChatTurnTimingRow = {
  id: string
  sessionKey: string
  runId: string
  textPreview: string
  /** 点击发送 */
  sendAt: number
  /** 乐观用户气泡挂上时间线（≈上屏） */
  userBubbleAt: number | null
  wireAt: number | null
  runStartedAt: number | null
  firstResponseAt: number | null
  firstKind: string | null
  firstPreview: string
  streamEndAt: number | null
  outcome: string | null
  /** 收口人话：谁停的 / 怎么结束的（来自 stream-stop whoZh） */
  endWhoZh: string | null
  /** 收口 trigger（composer_stop_button / sse_aborted / client_attach …） */
  endTrigger: string | null
  /**
   * 流错误 / RUN_ERROR 的人话原因（toUserFacingError）。
   * 例：「本轮生成失败：模型服务临时内部错误，直接再发一次通常就能过」
   */
  endErrMsg: string | null
}

/** 水位线旁路：同会话近期停止归因（避免 timing ↔ stream-stop 循环 import） */
export type ChatTurnWaterlineStopHint = {
  atMs: number
  whoZh: string
  trigger: string
  kind: string
  sessionKey?: string
  runId?: string
  fromUiStopButton?: boolean
  /** 流错误人话原因（detail.errMsg）；诊断「莫名其妙停」主字段 */
  errMsg?: string | null
}

export type ChatTurnTimingVerdictLevel = 'ok' | 'pending' | 'warn' | 'error'

export type ChatTurnTimingVerdict = {
  level: ChatTurnTimingVerdictLevel
  /** 短中文：正常 / 进行中 / 偏慢首字 / 久等无首字 … */
  zh: string
}

/** 复制诊断 / 水位线旁路：把同一时间窗内的接口成败挂到异常回合上 */
export type ChatTurnWaterlineApiHint = {
  at: number
  path: string
  ok: boolean
  ms: number | null
  status?: number | null
  error?: string | null
}

const TIMING_RING_MAX = 40
/** 正常收口的回合只保留最近若干条；异常/进行中全留（直到环满） */
const TIMING_OK_KEEP = 8
const timingRing: ChatTurnTimingRow[] = []
const timingListeners = new Set<() => void>()
let activeTimingId: string | null = null

/**
 * 水位线判定：页面出泡 / 上线 / 首字 / 收口是否正常。
 * 正常 → 诊断里一行摘要，环内会收紧；异常 → 留阶段差 + 前后接口。
 */
export function classifyChatTurnTimingVerdict(
  row: ChatTurnTimingRow,
  nowMs: number = Date.now(),
): ChatTurnTimingVerdict {
  const age = Math.max(0, nowMs - row.sendAt)
  const firstMs =
    row.firstResponseAt != null ? Math.max(0, row.firstResponseAt - row.sendAt) : null

  if (row.outcome === 'stream_error') {
    return { level: 'error', zh: '流错误' }
  }
  if (row.outcome === 'sse_aborted') {
    return { level: 'error', zh: '断流' }
  }
  if (row.outcome === 'sse_final' || row.outcome === 'ui_stop' || row.outcome === 'other') {
    if (row.firstResponseAt == null) {
      return { level: 'warn', zh: '收口但无首字' }
    }
    if (firstMs != null && firstMs >= 30_000) {
      return { level: 'warn', zh: `慢首字 ${firstMs}ms` }
    }
    if (firstMs != null && firstMs >= SLOW_FIRST_MS) {
      return { level: 'warn', zh: `偏慢首字 ${firstMs}ms` }
    }
    if (row.outcome === 'ui_stop') {
      const who = String(row.endWhoZh || '').trim()
      // 点停 / 打断重发都会走 ui_stop；有 whoZh 时别一律写「用户停止」
      if (who && !/用户停止|用户点击|用户按 Esc/.test(who)) {
        return { level: 'ok', zh: who.slice(0, 18) }
      }
      return { level: 'ok', zh: who.includes('用户') ? '用户停止' : '已停止' }
    }
    if (row.outcome === 'other') {
      return { level: 'warn', zh: '其它结束' }
    }
    return { level: 'ok', zh: '正常' }
  }

  // 未收口：按卡住阶段升级
  if (row.wireAt == null && age >= 5_000) {
    return { level: 'error', zh: '未上线' }
  }
  if (row.firstResponseAt == null && age >= 30_000) {
    return { level: 'error', zh: '久等无首字' }
  }
  if (row.firstResponseAt == null && age >= 12_000) {
    return { level: 'warn', zh: '等首字中' }
  }
  if (
    row.firstResponseAt != null &&
    row.streamEndAt == null &&
    age >= STREAM_END_DEAD_MS
  ) {
    return { level: 'error', zh: '久等无收口' }
  }
  if (row.firstResponseAt != null) {
    return { level: 'pending', zh: '流式中' }
  }
  return { level: 'pending', zh: '进行中' }
}

function pruneTimingRingKeepAbnormal(): void {
  const now = Date.now()
  const okIds: string[] = []
  const mustKeep = new Set<string>()
  for (const r of timingRing) {
    const v = classifyChatTurnTimingVerdict(r, now)
    if (v.level === 'ok') okIds.push(r.id)
    else mustKeep.add(r.id)
  }
  const okKeep = new Set(okIds.slice(-TIMING_OK_KEEP))
  const next = timingRing.filter((r) => mustKeep.has(r.id) || okKeep.has(r.id))
  if (next.length === timingRing.length) return
  timingRing.length = 0
  timingRing.push(...next)
  notifyTiming()
}

function fmtClock(at: number): string {
  try {
    return new Date(at).toLocaleTimeString('zh-CN', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return String(at)
  }
}

function fmtDelta(at: number | null, sendAt: number): string {
  if (at == null) return '—'
  return `+${Math.max(0, at - sendAt)}ms`
}

/**
 * 运维「发送水位线」：发了几次、何时上屏、接口/首字/收口是否正常。
 * 正常回合一行摘要；异常回合展开阶段差 + 时间窗内接口。
 */
export function formatChatTurnWaterlineForDiag(opts?: {
  sessionKey?: string | null
  limit?: number
  apiHints?: ChatTurnWaterlineApiHint[]
  anomalies?: ChatTurnAnomaly[]
  /** 近期停止归因（点停/Esc/client_attach/断流…）；来自 getStreamStopRing */
  stopHints?: ChatTurnWaterlineStopHint[]
}): string[] {
  const rows = listChatTurnTimingRows({
    sessionKey: opts?.sessionKey,
    limit: opts?.limit ?? TIMING_RING_MAX,
  })
  const lines: string[] = []
  const now = Date.now()
  const skFilter = String(opts?.sessionKey || '').trim()
  const stopHints = (opts?.stopHints || []).filter((s) => {
    if (!skFilter) return true
    if (!s.sessionKey) return true
    return s.sessionKey === skFilter
  })
  const verdicts = rows.map((r) => ({
    row: r,
    v: classifyChatTurnTimingVerdict(r, now),
  }))
  const abnormal = verdicts.filter(
    (x) => x.v.level === 'warn' || x.v.level === 'error',
  )
  const pending = verdicts.filter((x) => x.v.level === 'pending')
  lines.push(
    `### 发送水位线（本会话 ${rows.length} 发 · 异常 ${abnormal.length} · 进行中 ${pending.length}）`,
  )
  lines.push(
    '- 策略：正常收口只留摘要；异常保留阶段差 + 前后接口 + 停止归因，方便下次诊断「发了几次 / 卡在哪 / 谁停的」',
  )
  if (rows.length === 0) {
    lines.push('- （尚无发送记录；点发送后会出现：发送时刻 → 出泡上屏 → 上线 → 首字 → 收口）')
  } else {
  // 倒序：最近发送在上
  const ordered = [...verdicts].reverse()
  for (let i = 0; i < ordered.length; i++) {
    const { row, v } = ordered[i]!
    const n = ordered.length - i
    const preview = (row.textPreview || '（空）').slice(0, 40)
    const tag =
      v.level === 'ok'
        ? '正常'
        : v.level === 'pending'
          ? '进行中'
          : v.level === 'warn'
            ? `异常·${v.zh}`
            : `异常·${v.zh}`
    const whoBit = row.endWhoZh ? ` 谁=${row.endWhoZh}` : ''
    const base =
      `${n}. [${tag}] ${fmtClock(row.sendAt)} 「${preview}」` +
      ` 出泡${fmtDelta(row.userBubbleAt, row.sendAt)}` +
      ` 上线${fmtDelta(row.wireAt, row.sendAt)}` +
      ` 开跑${fmtDelta(row.runStartedAt, row.sendAt)}` +
      ` 首字${fmtDelta(row.firstResponseAt, row.sendAt)}` +
      ` 结束${fmtDelta(row.streamEndAt, row.sendAt)}` +
      whoBit
    lines.push(`- ${base}`)

    if (v.level === 'ok') continue

    // 异常 / 进行中：展开阶段 + 时间窗接口
    const stageBits: string[] = []
    if (row.userBubbleAt == null) stageBits.push('页面未出用户泡')
    else if (row.wireAt == null) stageBits.push('已出泡、未上线(chatSend)')
    else if (row.runStartedAt == null) stageBits.push('已上线、等 RUN_STARTED')
    else if (row.firstResponseAt == null) stageBits.push('已开跑、等首字')
    else if (row.streamEndAt == null) stageBits.push('已有首字、等收口')
    if (row.outcome) stageBits.push(`outcome=${row.outcome}`)
    if (row.endTrigger) stageBits.push(`trigger=${row.endTrigger}`)
    if (row.endWhoZh) stageBits.push(`谁=${row.endWhoZh}`)
    if (stageBits.length) {
      lines.push(`  卡点: ${stageBits.join(' · ')}`)
    }
    // 流错误人话原因：工具卡中间停往往是 RUN_ERROR，不是工具本身失败
    const endErr = String(row.endErrMsg || '').trim()
    if (endErr) {
      lines.push(`  原因: ${endErr.slice(0, 160)}`)
    }

    const winStart = row.sendAt - 2_000
    const winEnd = (row.streamEndAt ?? now) + 2_000
    const apis = (opts?.apiHints || []).filter(
      (a) => a.at >= winStart && a.at <= winEnd,
    )
    const signalApis = apis
      .filter((a) => {
        const p = a.path.toLowerCase()
        return (
          !a.ok ||
          p.includes('subscribe') ||
          p.includes('chatsend') ||
          p.includes('/chat') ||
          p.includes('run')
        )
      })
      .slice(-8)
    if (signalApis.length > 0) {
      lines.push(
        `  前后接口: ${signalApis
          .map((a) => {
            const ms = a.ms != null ? `${a.ms}ms` : '?'
            const st = a.status != null ? ` ${a.status}` : ''
            const err = a.error ? ` ${String(a.error).slice(0, 40)}` : ''
            return `${a.path} ${a.ok ? '✓' : '✗'}${st} ${ms}${err}`
          })
          .join('；')}`,
      )
    }

    const turns = (opts?.anomalies || []).filter((a) => {
      if (a.sessionKey && row.sessionKey && a.sessionKey !== row.sessionKey) {
        return false
      }
      return a.at >= winStart && a.at <= winEnd
    })
    if (turns.length > 0) {
      lines.push(
        `  回合异常: ${turns
          .slice(-4)
          .map((a) => `${a.event}@${a.sinceSendMs}ms(${a.stage})`)
          .join('；')}`,
      )
    }

    const nearStops = stopHints.filter((s) => s.atMs >= winStart && s.atMs <= winEnd)
    if (nearStops.length > 0) {
      lines.push(
        `  停止归因: ${nearStops
          .slice(-4)
          .map((s) => {
            const reason = String(s.errMsg || '').trim()
            const base = `${s.whoZh}(${s.trigger}/${s.kind})`
            return reason ? `${base} · ${reason.slice(0, 80)}` : base
          })
          .join('；')}`,
      )
    }
  }
  } // end rows.length > 0

  lines.push('')
  lines.push('### 停止归因（谁停的 / 用户操作）')
  lines.push(
    '- 点停、Esc、打断重发、client_attach、断流都会落这里；「用户停止」只该出现在真点停/Esc；流错误带「原因=」',
  )
  if (stopHints.length === 0) {
    lines.push('- （尚无停止记录；点停止或断流后会出现 whoZh）')
  } else {
    for (const s of stopHints.slice(-12).reverse()) {
      const sk = s.sessionKey ? ` sk=${s.sessionKey.slice(0, 28)}` : ''
      const ui = s.fromUiStopButton ? ' uiStop' : ''
      const reason = String(s.errMsg || '').trim()
      const reasonBit = reason ? ` · 原因=${reason.slice(0, 120)}` : ''
      lines.push(
        `- ${fmtClock(s.atMs)} [${s.kind}] ${s.whoZh} · trigger=${s.trigger}${ui}${sk}${reasonBit}`,
      )
    }
  }
  return lines
}

function notifyTiming(): void {
  for (const fn of timingListeners) {
    try {
      fn()
    } catch {
      /* ignore */
    }
  }
}

function persistTimingRow(row: ChatTurnTimingRow): void {
  const sid = row.sessionKey || ''
  if (!sid) return
  persistViewportTap(sid, 'timing', {
    id: row.id,
    sessionKey: row.sessionKey,
    runId: row.runId || undefined,
    textPreview: row.textPreview || undefined,
    sendAt: row.sendAt,
    userBubbleAt: row.userBubbleAt,
    wireAt: row.wireAt,
    runStartedAt: row.runStartedAt,
    firstResponseAt: row.firstResponseAt,
    firstKind: row.firstKind || undefined,
    firstPreview: row.firstPreview || undefined,
    streamEndAt: row.streamEndAt,
    outcome: row.outcome || undefined,
    endWhoZh: row.endWhoZh || undefined,
    endTrigger: row.endTrigger || undefined,
    endErrMsg: row.endErrMsg || undefined,
    wireMs: row.wireAt != null ? row.wireAt - row.sendAt : null,
    bubbleMs: row.userBubbleAt != null ? row.userBubbleAt - row.sendAt : null,
    firstMs: row.firstResponseAt != null ? row.firstResponseAt - row.sendAt : null,
    endMs: row.streamEndAt != null ? row.streamEndAt - row.sendAt : null,
  })
}

/**
 * 收口/首字要绑「真正开跑的那一行」，不能只信 activeTimingId：
 * 连点/卡住重发会顶掉 active，导致 sse_final 落在空行上，诊断里仍显示「久等无收口」。
 */
function resolveTimingRowId(opts?: {
  id?: string | null
  sessionKey?: string | null
  runId?: string | null
  preferOpen?: boolean
}): string | null {
  const explicit = String(opts?.id || '').trim()
  if (explicit && timingRing.some((r) => r.id === explicit)) return explicit

  const runId = String(opts?.runId || '').trim()
  if (runId) {
    for (let i = timingRing.length - 1; i >= 0; i--) {
      const r = timingRing[i]!
      if (r.runId && r.runId === runId) return r.id
    }
  }

  const sk = String(opts?.sessionKey || '').trim()
  if (sk && opts?.preferOpen) {
    for (let i = timingRing.length - 1; i >= 0; i--) {
      const r = timingRing[i]!
      if (r.sessionKey !== sk) continue
      if (r.streamEndAt != null) continue
      // 优先已上线/已有首字的行，跳过连点留下的空壳
      if (r.wireAt != null || r.firstResponseAt != null || r.runStartedAt != null) {
        return r.id
      }
    }
  }

  if (activeTimingId && timingRing.some((r) => r.id === activeTimingId)) {
    return activeTimingId
  }
  return null
}

function upsertTimingRow(
  patch: Partial<ChatTurnTimingRow> & {
    id?: string
    /** 按 runId / 同会话未收口行回绑（stream_end / first_response） */
    rebind?: boolean
  },
): ChatTurnTimingRow | null {
  const id = resolveTimingRowId({
    id: patch.id,
    sessionKey: patch.sessionKey,
    runId: patch.runId,
    preferOpen: !!patch.rebind,
  })
  if (!id) return null
  const idx = timingRing.findIndex((r) => r.id === id)
  if (idx < 0) return null
  const { rebind: _rebind, ...rest } = patch
  const next = { ...timingRing[idx], ...rest, id }
  timingRing[idx] = next
  // 收口绑回真实行时，同步 active，避免后续补丁再落到空壳
  if (patch.rebind) activeTimingId = id
  notifyTiming()
  persistTimingRow(next)
  return next
}

function beginTimingRow(opts: {
  sessionKey: string
  textPreview: string
  sendAt: number
}): ChatTurnTimingRow {
  // 同毫秒/同文案连点：复用已有空壳，避免诊断「4 发」里混进未上线幽灵行
  const sk = opts.sessionKey
  const preview = opts.textPreview
  for (let i = timingRing.length - 1; i >= 0; i--) {
    const r = timingRing[i]!
    if (r.sessionKey !== sk) continue
    if (r.textPreview !== preview) continue
    if (r.wireAt != null || r.streamEndAt != null) continue
    if (Math.abs(r.sendAt - opts.sendAt) > 1500) continue
    activeTimingId = r.id
    notifyTiming()
    return r
  }
  const id = `t-${opts.sendAt}-${Math.random().toString(36).slice(2, 7)}`
  const row: ChatTurnTimingRow = {
    id,
    sessionKey: opts.sessionKey,
    runId: '',
    textPreview: opts.textPreview,
    sendAt: opts.sendAt,
    userBubbleAt: null,
    wireAt: null,
    runStartedAt: null,
    firstResponseAt: null,
    firstKind: null,
    firstPreview: '',
    streamEndAt: null,
    outcome: null,
    endWhoZh: null,
    endTrigger: null,
    endErrMsg: null,
  }
  timingRing.push(row)
  while (timingRing.length > TIMING_RING_MAX) timingRing.shift()
  activeTimingId = id
  notifyTiming()
  persistTimingRow(row)
  return row
}

export function listChatTurnTimingRows(opts?: {
  sessionKey?: string | null
  limit?: number
}): ChatTurnTimingRow[] {
  const limit = Math.max(1, Math.min(TIMING_RING_MAX, opts?.limit ?? TIMING_RING_MAX))
  const sk = String(opts?.sessionKey || '').trim()
  const source = sk
    ? timingRing.filter((r) => !r.sessionKey || r.sessionKey === sk)
    : timingRing
  return source.slice(-limit)
}

export function subscribeChatTurnTiming(listener: () => void): () => void {
  timingListeners.add(listener)
  return () => {
    timingListeners.delete(listener)
  }
}

/** 乐观用户气泡已挂上时间线（上屏）。同一轮只记首次。 */
export function logChatTurnUserBubbleVisible(opts?: {
  sessionKey?: string | null
}): void {
  const sessionKey = String(opts?.sessionKey || '').trim()
  const row =
    (activeTimingId && timingRing.find((r) => r.id === activeTimingId)) ||
    timingRing.slice().reverse().find((r) => {
      if (r.userBubbleAt != null) return false
      if (!sessionKey) return true
      return !r.sessionKey || r.sessionKey === sessionKey
    })
  if (!row || row.userBubbleAt != null) return
  if (sessionKey && row.sessionKey && sessionKey !== row.sessionKey) return
  upsertTimingRow({ id: row.id, userBubbleAt: Date.now() })
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
    upsertTimingRow({
      sessionKey: sessionKey || sendTrace.sessionKey,
      textPreview: textPreview || sendTrace.textPreview,
    })
    return { sendClickAlreadyLogged: !!sendTrace.sendClickLogged }
  }
  archiveUnansweredSendTrace()
  const startedAt = Date.now()
  sendTrace = {
    sessionKey,
    startedAt,
    textPreview,
    attachmentCount,
    sendClickLogged: false,
    firstResponseLogged: false,
    wireLogged: false,
    runStartedLogged: false,
  }
  beginTimingRow({ sessionKey, textPreview, sendAt: startedAt })
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
  const startedAt = Date.now()
  sendTrace = {
    sessionKey: sessionKey || sendTrace?.sessionKey || '',
    startedAt,
    textPreview,
    attachmentCount,
    sendClickLogged: true,
    firstResponseLogged: false,
    wireLogged: false,
    runStartedLogged: false,
    streamEndLogged: false,
    runId: undefined,
  }
  beginTimingRow({
    sessionKey: sessionKey || sendTrace.sessionKey || '',
    textPreview,
    sendAt: startedAt,
  })
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
  const runId = String(opts.runId || '').trim()
  if (runId) sendTrace.runId = runId
  upsertTimingRow({
    wireAt: Date.now(),
    ...(runId ? { runId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
  })
  emit(
    `消息已上线（chatSend）：${sinceDesc}${since != null && since >= SLOW_FIRST_MS ? ' —— 发送准备偏慢（paint/context/abort/beforeWire）' : ''}`,
    {
      event: 'send_wire',
      sessionKey: sessionKey || sendTrace.sessionKey || undefined,
      runId: runId || undefined,
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
  upsertTimingRow({
    runStartedAt: Date.now(),
    rebind: true,
    ...(runId ? { runId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
  })
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
  upsertTimingRow({
    firstResponseAt: Date.now(),
    firstKind: opts.kind,
    firstPreview: preview,
    rebind: true,
    ...(runId ? { runId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
  })
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

/** 从 stream-stop detail 抽出人话 errMsg（或 rawErr 兜底）。 */
function extractEndErrMsg(detail?: Record<string, unknown> | null): string | null {
  if (!detail || typeof detail !== 'object') return null
  for (const key of ['errMsg', 'errorMessage', 'message', 'rawErr'] as const) {
    const v = detail[key]
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 200)
  }
  return null
}

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
  const endErrMsg = extractEndErrMsg(opts.detail)
  const level =
    outcome === 'sse_final' ? 'info' : outcome === 'ui_stop' ? 'info' : 'warn'
  const endRunId = String(opts.runId || sendTrace?.runId || '').trim()
  upsertTimingRow({
    streamEndAt: Date.now(),
    outcome,
    endWhoZh: who,
    endTrigger: trigger,
    ...(endErrMsg ? { endErrMsg } : {}),
    rebind: true,
    ...(endRunId ? { runId: endRunId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
  })
  emit(`流式结束：${who}${sinceDesc}`, {
    event: 'stream_end',
    outcome,
    trigger,
    whoZh: who,
    hasEndMarker: !!opts.hasEndMarker,
    sessionKey: sessionKey || sendTrace?.sessionKey || undefined,
    runId: endRunId || undefined,
    textPreview: sendTrace?.textPreview || undefined,
    ...(since != null ? { sinceSendMs: since } : {}),
    ...(endErrMsg ? { errMsg: endErrMsg } : {}),
    ...(opts.detail || {}),
  }, level)
  stopFirstTokenWatch()
  stopStreamEndWatch()
  // 正常收口 → 收紧旧「正常」行；异常全留，下次诊断还能看到发了几次、卡在哪
  pruneTimingRingKeepAbnormal()
  // 结束后清本轮锚点，避免下一轮误绑 sinceSendMs
  if (sendTrace && sendTrace.streamEndLogged) {
    sendTrace = null
  }
  activeTimingId = null
  clearUnansweredIfMatched(sessionKey)
}
