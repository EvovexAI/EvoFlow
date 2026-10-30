/**
 * 对话回合关键时间点中文日志（发送点击 / 右上角状态卡 / 首帧响应）。
 *
 * ## 落点
 * 1. DevTools Console：过滤 `[回合计时]`
 * 2. 桌面端：`~/.evoflow/logs/frontend-YYYY-MM-DD.log`（`append_frontend_log`）
 *
 * 关闭：localStorage.setItem('EVOFLOW_TURN_TIMING_LOG', '0')
 *
 * 慢首帧拆解：看 sinceSendMs 在
 * send_click → send_wire → run_started → first_response 之间的差。
 */
const PREFIX = '[回合计时]'
const LS_ENABLE_KEY = 'EVOFLOW_TURN_TIMING_LOG'
const SLOW_FIRST_MS = 3_000
const SEND_CLICK_BIND_MS = 12_000

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
}

let sendTrace: ChatTurnSendTrace | null = null
/** 同一会话状态卡展示去重，避免 effect 连打 */
const summaryShownRecent = new Map<string, number>()
const SUMMARY_DEDUPE_MS = 1_500

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
  if (level === 'error') console.error(line, payload)
  else if (level === 'warn') console.warn(line, payload)
  else console.info(line, payload)
  persistToFrontendLog(level, `${line} ${safeJson(payload)}`)
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
  sendTrace = {
    sessionKey: sessionKey || sendTrace?.sessionKey || '',
    startedAt: Date.now(),
    textPreview,
    attachmentCount,
    sendClickLogged: true,
    firstResponseLogged: false,
    wireLogged: false,
    runStartedLogged: false,
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
    `消息已上线（chatSend）：${sinceDesc}${since != null && since >= SLOW_FIRST_MS ? ' —— 发送准备偏慢（context/abort/beforeWire）' : ''}`,
    {
      event: 'send_wire',
      sessionKey: sessionKey || sendTrace.sessionKey || undefined,
      runId: String(opts.runId || '').trim() || undefined,
      ...(since != null ? { sinceSendMs: since } : {}),
    },
    level,
  )
}

/** AG-UI RUN_STARTED：服务端开始跑本轮 */
export function logChatTurnRunStarted(opts: {
  sessionKey?: string | null
  runId?: string | null
}): void {
  if (!sendTrace || sendTrace.runStartedLogged) return
  const sessionKey = String(opts.sessionKey || '').trim()
  if (sessionKey && sendTrace.sessionKey && sessionKey !== sendTrace.sessionKey) return
  if (sessionKey && !sendTrace.sessionKey) sendTrace.sessionKey = sessionKey
  sendTrace.runStartedLogged = true
  const since = chatTurnSinceSendMs(sessionKey || sendTrace.sessionKey)
  const sinceDesc = since != null ? `距点击 ${since}ms` : '无点击锚点'
  const level = since != null && since >= SLOW_FIRST_MS ? 'warn' : 'info'
  emit(
    `回合已开始（RUN_STARTED）：${sinceDesc}${since != null && since >= SLOW_FIRST_MS ? ' —— 等服务端开跑偏慢' : ''}`,
    {
      event: 'run_started',
      sessionKey: sessionKey || sendTrace.sessionKey || undefined,
      runId: String(opts.runId || '').trim() || undefined,
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
  if (sendTrace) {
    if (sessionKey && sendTrace.sessionKey && sessionKey !== sendTrace.sessionKey) return
    if (sendTrace.firstResponseLogged) return
    sendTrace.firstResponseLogged = true
    if (sessionKey && !sendTrace.sessionKey) sendTrace.sessionKey = sessionKey
  }
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
  emit(`首帧响应：类型=${kindLabel}${sinceDesc}${previewDesc}${gateDesc}${slow}`, {
    event: 'first_response',
    sessionKey: sessionKey || sendTrace?.sessionKey || undefined,
    kind: opts.kind,
    eventType: opts.eventType || undefined,
    runId: opts.runId || undefined,
    preview: preview || undefined,
    gatedByV4: opts.gatedByV4 || undefined,
    ...(since != null ? { sinceSendMs: since } : {}),
  }, level)
}
