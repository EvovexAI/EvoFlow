import type { ChatSessionRow } from '../chat-types.js'

export type TurnTimingSession = Pick<
  ChatSessionRow,
  'runStatus' | 'currentTurnStartedAt' | 'currentTurnEndedAt'
>

const ACTIVE_RUN_STATUSES = new Set(['running', 'pending'])

export function parseTurnTimestampMs(value: unknown): number | null {
  if (value == null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  const ts = new Date(String(value)).getTime()
  return Number.isFinite(ts) ? ts : null
}

export function isActiveRunStatus(status: unknown): boolean {
  return ACTIVE_RUN_STATUSES.has(String(status || '').trim().toLowerCase())
}

/** 当前轮次是否仍在计时（DB 有 start 且 run 未 idle）。 */
export function isTurnTimingLive(session: TurnTimingSession | null | undefined): boolean {
  if (!session) return false
  if (!isActiveRunStatus(session.runStatus)) return false
  return parseTurnTimestampMs(session.currentTurnStartedAt) != null
}

export type ComputeTurnElapsedSecOpts = {
  nowMs?: number
  /** 轮次结束时冻结终点（final 事件等）；缺省用 DB endedAt 或 now。 */
  endMs?: number | null
  /**
   * Start fallback when DB ``currentTurnStartedAt`` is missing
   * (typically ``sessionRuntime.turnStartTs``).
   * Resolution: currentTurnStartedAt → fallbackStartMs → unavailable.
   */
  fallbackStartMs?: number | null
}

/** Resolve turn wall-clock start: DB first, then runtime fallback. */
export function resolveTurnStartMs(
  session: TurnTimingSession | null | undefined,
  fallbackStartMs?: number | null,
): number | null {
  const fromDb = parseTurnTimestampMs(session?.currentTurnStartedAt)
  if (fromDb != null) return fromDb
  if (fallbackStartMs != null && Number.isFinite(fallbackStartMs) && fallbackStartMs > 0) {
    return Math.round(fallbackStartMs)
  }
  return null
}

/**
 * 整轮耗时（秒）。
 * Start: ``currentTurnStartedAt`` → ``fallbackStartMs``（runtime turnStartTs）。
 * End: 显式 endMs → ``currentTurnEndedAt`` → now（仅 active run）。
 */
export function computeTurnElapsedSec(
  session: TurnTimingSession | null | undefined,
  opts: ComputeTurnElapsedSecOpts = {},
): number | undefined {
  const startMs = resolveTurnStartMs(session, opts.fallbackStartMs)
  if (startMs == null) return undefined

  let endMs: number | null | undefined = opts.endMs
  if (endMs == null) {
    const endedAt = parseTurnTimestampMs(session?.currentTurnEndedAt)
    if (endedAt != null) endMs = endedAt
    else if (isActiveRunStatus(session?.runStatus)) endMs = opts.nowMs ?? Date.now()
    else return undefined
  }
  if (endMs == null || !Number.isFinite(endMs)) return undefined
  return Math.max(0, Math.floor((endMs - startMs) / 1000))
}

/** 气泡 meta / 落库行：``12s`` 或 ``1m05s``。 */
export function formatTurnDurationStr(elapsedSec: number): string {
  const sec = Math.max(0, Math.floor(elapsedSec))
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m${s.toString().padStart(2, '0')}s`
}

/** 状态行 / Dock 后缀：`` · 12s`` 或 `` · 1m05s``。 */
export function formatTurnElapsedSuffix(elapsedSec?: number): string {
  if (elapsedSec == null) return ''
  const core = formatTurnDurationStr(elapsedSec)
  return core ? ` · ${core}` : ''
}

/**
 * 思考段折叠头标签（ZCode 风格）：「持续了 16 秒」「持续了 2 分 16 秒」。
 * 不足 1 秒视为极短，返回空串（不展示时长）。
 */
export function formatReasoningDurationLabel(durationMs: number | null | undefined): string {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs <= 0) return ''
  const totalSec = Math.round(durationMs / 1000)
  if (totalSec < 1) return ''
  if (totalSec < 60) return `持续了 ${totalSec} 秒`
  const totalMin = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (totalMin < 60) {
    return s ? `持续了 ${totalMin} 分 ${s.toString().padStart(2, '0')} 秒` : `持续了 ${totalMin} 分`
  }
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m ? `持续了 ${h} 小时 ${m} 分` : `持续了 ${h} 小时`
}

/**
 * 回合完成态折叠头标签（ZCode 风格）：「已工作 5 分 22 秒」。
 * 入参为 formatTurnDurationStr 形态的时长串（``12s`` / ``1m05s`` / ``1h2m3s``），
 * 解析失败返回空串（调用方退回平铺）。
 */
export function formatWorkedDurationLabel(durationLabel: string | null | undefined): string {
  const raw = String(durationLabel || '').trim()
  if (!raw) return ''
  const m = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i)
  if (!m) return ''
  const h = Number(m[1] || 0)
  const min = Number(m[2] || 0)
  const s = Number(m[3] || 0)
  if (!h && !min && !s) return ''
  const parts: string[] = []
  if (h) parts.push(`${h} 小时`)
  if (min) parts.push(`${min} 分`)
  if (s) parts.push(`${s} 秒`)
  return `已工作 ${parts.join(' ')}`
}

/**
 * Compat only: reverse-parse a duration token from a composite dock/status string
 * like ``推理中 · 1m32s``. Prefer raw ``elapsedSec`` → ``formatTurnDurationStr``.
 */
export function parseDurationLabelFromDockCompat(dockLabel: unknown): string | undefined {
  const s = String(dockLabel || '').trim()
  if (!s) return undefined
  const m = s.match(/(\d+h\d+m\d+s|\d+m\d+s|\d+h\d+m|\d+m|\d+s)/i)
  return m?.[1]
}

/** Strip trailing `` · 1m32s`` from dock/status copy so UI can append duration once. */
export function stripTurnDurationSuffix(label: unknown): string {
  return String(label || '')
    .trim()
    .replace(/\s*·\s*(?:\d+h\d+m\d+s|\d+m\d+s|\d+h\d+m|\d+m|\d+s)\s*$/i, '')
    .trim()
}

/**
 * Resolve a turn duration label for telemetry / meta.
 * Order: raw elapsedSec → format; sealed durationStr; dock-string compat parse.
 */
export function resolveTurnDurationLabel(opts: {
  elapsedSec?: number | null
  sealedDurationStr?: string | null
  /** @deprecated Compat path when raw timing is unavailable. */
  dockLabelCompat?: string | null
}): string | undefined {
  if (opts.elapsedSec != null && Number.isFinite(opts.elapsedSec) && opts.elapsedSec >= 0) {
    return formatTurnDurationStr(opts.elapsedSec)
  }
  const sealed = String(opts.sealedDurationStr || '').trim()
  if (sealed) return sealed
  return parseDurationLabelFromDockCompat(opts.dockLabelCompat)
}

export function sessionHasLiveTurnTiming(
  sessions: readonly TurnTimingSession[],
  sessionKey: string,
): boolean {
  const sk = String(sessionKey || '').trim()
  if (!sk) return false
  const row = sessions.find((s) => String((s as ChatSessionRow).sessionKey || '') === sk)
  return isTurnTimingLive(row)
}

export function anySessionHasLiveTurnTiming(sessions: readonly TurnTimingSession[]): boolean {
  return sessions.some((s) => isTurnTimingLive(s))
}
