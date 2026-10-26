/**
 * 小V「语音播报」调试日志（前端 → 后端落盘分文件）。
 *
 * 目录：logs/语音播报/
 *   - 前端-YYYY-MM-DD.log
 *   - 后端-YYYY-MM-DD.log
 *
 * TRACE：一轮提问→播报共用同一 ID；前后端每行都带 [TRACE=vt-…]，grep 即可串起来。
 * 核对阶段：面板（上屏/发送）| 流式正文 | 语音合成 | 语音播放 | 播放结束
 *
 * 面板约定（便于对照 UI）：
 *   - [面板] 上屏：「…」 at=本地时间  → 左侧「你」/草稿当时显示的字
 *   - [对话] 发送：「…」 发送于=… 上屏于=… → 真正发出去的字 + 两个时间点
 *   - [状态] 聆听/播报/处理中/思考中/空闲 at=… → 舞台当时状态（播报中不会记成聆听）
 *   - [已经进入] / [关闭退出] / [已经退出] → 语音对话区闸门（关面板 = 退出整套听麦/播报）
 *   - [时效] 唤醒链路里程碑 + since_hit_ms → 排查「唤醒慢」
 *   - [决策] unmute/defer/barge/tray 取舍 + 关键布尔 → 排查卡顿/误打断/状态闪回
 *   - [决策] phase from→to / client_phase → VoicePhase 门控（listening 才 unmute，speaking 才 barge）
 */

import { apiUrl } from '../api-client.js'

/** @typedef {{ stage: string, message: string, detail?: string, source?: string, ts?: string, trace?: string }} VoiceLogEntry */

/** @type {VoiceLogEntry[]} */
const queue = []
/** @type {ReturnType<typeof setTimeout> | null} */
let timer = null
let pathLogged = false

/** 当前一轮播报 TRACE（与后端共用） */
let _traceId = ''
/** Frame 连接级 SID（可选，会话开始时后端下发） */
let _sid = ''

/** 面板最近一次上屏文案（与 UI「你」区对齐） */
let _panelText = ''
/** 最近上屏本地时间串 */
let _panelAt = ''
/** 最近上屏 epoch ms */
let _panelAtMs = 0
/** 上屏日志节流：合并过密的中间识别 */
let _panelLogTimer = 0
/** @type {string | null} */
let _panelPending = null
/** 发送去重：同一句短时间内只记一次（bridge + sendXiaomiChat 双路径） */
let _lastSendText = ''
let _lastSendAtMs = 0

/** 最近一次 UI 状态中文标签 */
let _uiStateLabel = ''

/**
 * 语音对话区闸门：entered | closing | exited
 * 关面板 ≡ 退出整套语音；日志 stage 固定为「已经进入 / 关闭退出 / 已经退出」。
 */
let _modeGate = /** @type {'entered' | 'closing' | 'exited'} */ ('exited')

/** tray / 舞台 state → 日志用中文（仅三态：聆听 / 思考 / 播报） */
const UI_STATE_LABEL = {
  recording: '聆听',
  listen: '聆听',
  idle: '聆听',
  '': '聆听',
  speaking: '播报',
  speak: '播报',
  processing: '思考',
  parse: '思考',
  running: '思考',
  think: '思考',
}

function clip(s, n = 800) {
  const t = String(s || '')
    .replace(/\r/g, ' ')
    .replace(/\n/g, ' ')
    .trim()
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`
}

/**
 * 本地墙钟，与落盘行首时间格式一致：YYYY-MM-DD HH:mm:ss.SSS
 * @param {Date | number} [when]
 * @returns {string}
 */
export function formatVoiceLocalTs(when = Date.now()) {
  const x = when instanceof Date ? when : new Date(when)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return (
    `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ` +
    `${p(x.getHours())}:${p(x.getMinutes())}:${p(x.getSeconds())}.${p(x.getMilliseconds(), 3)}`
  )
}

function _mintTrace(prefix = 'vt') {
  const p = String(prefix || 'vt').trim() || 'vt'
  const t = Date.now().toString(36)
  const r = Math.random().toString(36).slice(2, 6)
  return `${p}-${t}-${r}`
}

/** @returns {string} */
export function getVoiceTrace() {
  return _traceId || ''
}

/** @returns {string} */
export function getVoiceSid() {
  return _sid || ''
}

/**
 * 开启新一轮 TRACE（用户提问 / arm 播报时调用）。
 * @param {{ prefix?: string, reason?: string, keepIfSame?: boolean }} [opts]
 * @returns {string}
 */
export function beginVoiceTrace(opts = {}) {
  const next = _mintTrace(opts.prefix || 'vt')
  _traceId = next
  try {
    console.info('[xiaomi-voice] TRACE=', next, opts.reason || '')
  } catch {
    /* ignore */
  }
  voiceFeLog('会话', `新一轮 TRACE=${next}${opts.reason ? `（${opts.reason}）` : ''}`)
  return next
}

/**
 * 采用已有 TRACE（后端 turn_end / trace 事件对齐）。
 * @param {string} traceId
 * @param {{ sid?: string, reason?: string }} [opts]
 * @returns {string}
 */
export function adoptVoiceTrace(traceId, opts = {}) {
  const tid = String(traceId || '').trim()
  if (opts.sid) _sid = String(opts.sid).trim()
  if (!tid) return _traceId
  if (tid === _traceId) return _traceId
  _traceId = tid
  voiceFeLog(
    '会话',
    `对齐 TRACE=${tid}${opts.reason ? `（${opts.reason}）` : ''}${_sid ? ` SID=${_sid}` : ''}`,
  )
  return _traceId
}

export function setVoiceSid(sid) {
  const s = String(sid || '').trim()
  if (s) _sid = s
}

/**
 * 面板上屏：用户说话 → UI 显示的字 + 上屏时间。
 * 中间识别会短时合并，避免一行一字刷屏；内容变化与清空都会记。
 * @param {string} text
 * @param {{ source?: string, immediate?: boolean }} [opts]
 */
export function noteVoicePanelDisplay(text, opts = {}) {
  try {
    const t = String(text || '')
    if (t === _panelText && !opts.immediate) return
    if (!t.trim() && !_panelText.trim()) return

    const write = (finalText) => {
      const now = Date.now()
      _panelText = finalText
      _panelAtMs = now
      _panelAt = formatVoiceLocalTs(now)
      const source = opts.source ? ` source=${opts.source}` : ''
      if (!finalText.trim()) {
        voiceFeLog('面板', `清空上屏 at=${_panelAt}${source}`)
      } else {
        voiceFeLog('面板', `上屏：「${clip(finalText, 400)}」 at=${_panelAt}${source}`)
      }
    }

    if (opts.immediate || !t.trim()) {
      if (_panelLogTimer) {
        clearTimeout(_panelLogTimer)
        _panelLogTimer = 0
      }
      _panelPending = null
      write(t)
      return
    }

    // 合并 120ms 内的中间结果，只落最新一屏
    _panelPending = t
    if (_panelLogTimer) return
    _panelLogTimer = window.setTimeout(() => {
      _panelLogTimer = 0
      const pending = _panelPending
      _panelPending = null
      if (pending == null || pending === _panelText) return
      write(pending)
    }, 120)
  } catch {
    /* never throw */
  }
}

/**
 * 面板发送：真正发出去的字 + 发送时间；并附带最近上屏时间便于对照。
 * @param {string} text
 * @param {{ detail?: string, source?: string }} [opts]
 */
export function noteVoicePanelSend(text, opts = {}) {
  try {
    // 发送前冲掉待合并的上屏，保证「上屏于」对准发出去前最后一屏
    if (_panelLogTimer) {
      clearTimeout(_panelLogTimer)
      _panelLogTimer = 0
    }
    if (_panelPending != null && _panelPending !== _panelText) {
      noteVoicePanelDisplay(_panelPending, {
        immediate: true,
        source: opts.source || '发送前冲刷',
      })
    }
    _panelPending = null

    const t = String(text || '').trim()
    if (!t) return
    const now = Date.now()
    if (t === _lastSendText && now - _lastSendAtMs < 1000) return
    _lastSendText = t
    _lastSendAtMs = now
    const sendAt = formatVoiceLocalTs(now)
    const displayAt = _panelAt || ''
    const snap = String(_panelText || '').trim()
    const source = opts.source ? ` source=${opts.source}` : ''
    let msg = `发送：「${clip(t, 400)}」 发送于=${sendAt}`
    if (displayAt) msg += ` 上屏于=${displayAt}`
    if (snap && snap !== t) msg += ` 上屏快照：「${clip(snap, 200)}」`
    if (source) msg += source
    voiceFeLog('对话', msg, opts.detail != null ? { detail: opts.detail } : {})
    void flushVoiceFeLog()
  } catch {
    /* never throw */
  }
}

/** @returns {{ text: string, at: string, atMs: number }} */
export function getLastVoicePanelSnapshot() {
  return { text: _panelText, at: _panelAt, atMs: _panelAtMs }
}

/**
 * 舞台/托盘状态：聆听 | 播报 | 处理中 | 思考中 | 空闲 + 切换时间点。
 * @param {string} state recording|speaking|processing|running|idle|listen|speak|parse|think
 * @param {{ source?: string, force?: boolean }} [opts]
 */
export function noteVoiceUiState(state, opts = {}) {
  try {
    const raw = String(state || '')
    const label = UI_STATE_LABEL[raw] || (raw ? raw : '空闲')
    if (label === _uiStateLabel && !opts.force) return
    const prev = _uiStateLabel
    _uiStateLabel = label
    const at = formatVoiceLocalTs()
    const source = opts.source ? ` source=${opts.source}` : ''
    const msg = prev
      ? `${prev} → ${label} at=${at}${source}`
      : `${label} at=${at}${source}`
    voiceFeLog('状态', msg)
  } catch {
    /* never throw */
  }
}

/** @returns {string} */
export function getLastVoiceUiStateLabel() {
  return _uiStateLabel
}

/** @returns {'entered' | 'closing' | 'exited'} */
export function getVoiceModeGate() {
  return _modeGate
}

/**
 * 语音对话区开/关闸门打点（关面板 = 退出整套语音体系）。
 * 落盘 stage 固定三选一，便于 grep：
 *   - 已经进入
 *   - 关闭退出
 *   - 已经退出
 *
 * @param {'enter' | 'closing' | 'exited'} phase
 * @param {{
 *   reason?: string,
 *   source?: string,
 *   message?: string,
 *   force?: boolean,
 * }} [opts]
 */
export function noteVoiceModeGate(phase, opts = {}) {
  try {
    const raw = String(phase || '').trim()
    /** @type {'enter' | 'closing' | 'exited'} */
    const key = raw === 'enter' || raw === 'closing' || raw === 'exited' ? raw : 'exited'
    const stage =
      key === 'enter' ? '已经进入' : key === 'closing' ? '关闭退出' : '已经退出'

    // 去重：同态不刷屏；关面板时若已不在岗 → 记「已经退出」一眼看清
    if (key === 'closing' && _modeGate === 'exited' && !opts.force) {
      const at = formatVoiceLocalTs()
      const reason = opts.reason ? ` reason=${opts.reason}` : ''
      const source = opts.source ? ` source=${opts.source}` : ''
      voiceFeLog(
        '已经退出',
        `关闭时发现语音对话区已不在岗（不应再听用户说话） at=${at}${reason}${source}`,
      )
      void flushVoiceFeLog()
      return
    }
    if (key === 'closing' && _modeGate === 'closing' && !opts.force) return
    if (key === 'exited' && _modeGate === 'exited' && !opts.force) return
    if (key === 'enter' && _modeGate === 'entered' && !opts.force) {
      const at = formatVoiceLocalTs()
      const reason = opts.reason ? ` reason=${opts.reason}` : ''
      const source = opts.source ? ` source=${opts.source}` : ''
      voiceFeLog(
        '已经进入',
        `仍在语音对话区（再次确认进入） at=${at}${reason}${source}`,
      )
      void flushVoiceFeLog()
      return
    }

    _modeGate = key === 'enter' ? 'entered' : key === 'closing' ? 'closing' : 'exited'
    if (key === 'exited') _uiStateLabel = ''

    const at = formatVoiceLocalTs()
    const reason = opts.reason ? ` reason=${opts.reason}` : ''
    const source = opts.source ? ` source=${opts.source}` : ''
    const extra = opts.message ? ` ${clip(opts.message, 200)}` : ''
    const defaultMsg =
      key === 'enter'
        ? '语音对话区已打开，开始听麦/对话'
        : key === 'closing'
          ? '关闭语音对话区 → 退出整套语音（停听/停播，仅留唤醒耳）'
          : '语音对话区已关闭，语音体系已退出（不应再听用户说话）'
    voiceFeLog(stage, `${defaultMsg}${extra} at=${at}${reason}${source}`)
    void flushVoiceFeLog()
  } catch {
    /* never throw */
  }
}

/**
 * @param {string} stage 中文阶段，如「流式正文」「语音合成」「语音播放」
 * @param {string} message
 * @param {{ detail?: string, trace?: string }} [opts]
 */
export function voiceFeLog(stage, message, opts = {}) {
  try {
    const trace = String(opts.trace || _traceId || '').trim()
    queue.push({
      ts: new Date().toISOString(),
      source: '前端',
      stage: clip(stage, 32) || '过程',
      message: clip(message, 1200),
      ...(trace ? { trace } : {}),
      ...(opts.detail != null ? { detail: clip(opts.detail, 600) } : {}),
    })
    if (queue.length >= 8) {
      void flushVoiceFeLog()
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null
        void flushVoiceFeLog()
      }, 250)
    }
  } catch {
    /* never throw */
  }
}

/**
 * 四类打点：流式正文 / 语音合成 / 语音播放 / 播放结束。
 * @param {'流式正文'|'语音合成'|'语音播放'|'播放结束'|string} kind
 * @param {string} [content] 正文或播报句
 * @param {string} [extra] 附加说明（时间差、bytes、seq…）
 */
export function voicePlaybackMark(kind, content = '', extra = '') {
  try {
    const body = clip(content, 400)
    const mid = clip(extra, 200)
    const quoted = body ? `「${body}」` : ''
    const msg = [mid, quoted].filter(Boolean).join(' ') || kind
    voiceFeLog(kind || '过程', msg)
  } catch {
    /* ignore */
  }
}

/**
 * 决策点打点：unmute / barge / tray / defer。flags 会 JSON 进 detail，便于事后对照。
 * @param {string} action 短动作名，如 defer_listening / ignore_vad_barge / keep_think
 * @param {Record<string, unknown>} [flags]
 */
export function voiceDecisionLog(action, flags = {}) {
  try {
    const keys = Object.keys(flags || {})
    const compact = keys
      .map((k) => {
        const v = flags[k]
        if (typeof v === 'boolean') return `${k}=${v ? 1 : 0}`
        if (v == null) return `${k}=-`
        return `${k}=${String(v)}`
      })
      .join(' ')
    voiceFeLog('决策', `${action}${compact ? ` ${compact}` : ''}`, {
      detail: keys.length ? JSON.stringify(flags) : undefined,
    })
  } catch {
    /* ignore */
  }
}

/** @type {number} */
let _wakeHitAt = 0

/** 唤醒命中起点（后续 noteWakeMilestone 算 since_hit_ms） */
export function markWakeHitClock() {
  _wakeHitAt = performance.now()
}

/**
 * 唤醒链路里程碑。grep「时效」+「唤醒」即可看 hit→面板→Frame 各段耗时。
 * @param {string} step 如 open_panel / frame_pcm_ready
 * @param {Record<string, unknown>} [extra]
 */
export function noteWakeMilestone(step, extra = {}) {
  try {
    const since =
      _wakeHitAt > 0 ? Math.round(performance.now() - _wakeHitAt) : null
    const bits = Object.keys(extra || {})
      .map((k) => `${k}=${extra[k]}`)
      .join(' ')
    voiceFeLog(
      '时效',
      `唤醒 ${step}` +
        (since != null ? ` since_hit_ms=${since}` : '') +
        (bits ? ` ${bits}` : ''),
    )
  } catch {
    /* ignore */
  }
}

/**
 * 把控制台同类语音日志镜像进同一文件（不替代 console）。
 * @param {string} stage
 * @param {...unknown} args
 */
export function voiceFeMirror(stage, ...args) {
  try {
    const msg = args
      .map((a) => {
        if (a == null) return ''
        if (typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean') return String(a)
        try {
          return JSON.stringify(a)
        } catch {
          return String(a)
        }
      })
      .filter(Boolean)
      .join(' ')
    if (msg) voiceFeLog(stage || '过程', msg)
  } catch {
    /* ignore */
  }
}

export async function flushVoiceFeLog() {
  if (!queue.length) return
  const batch = queue.splice(0, queue.length)
  try {
    const url = apiUrl('/speech/log')
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ source: '前端', entries: batch }),
      keepalive: true,
    })
  } catch {
    // 丢弃本批；调试日志不可阻断语音
  }
}

/** 启动时打一行路径提示（控制台 + 文件）。 */
export async function noteVoiceLogPathOnce() {
  if (pathLogged) return
  pathLogged = true
  try {
    const url = apiUrl('/speech/log/path')
    const res = await fetch(url, { credentials: 'same-origin' })
    const data = await res.json().catch(() => ({}))
    const dir = data?.dir || '(未知目录)'
    const fe = data?.frontend || data?.path || '(未知)'
    console.info('[xiaomi-voice] 语音播报日志目录：', dir)
    console.info('[xiaomi-voice] 前端日志：', fe)
    if (data?.backend) console.info('[xiaomi-voice] 后端日志：', data.backend)
    console.info('[xiaomi-voice] 排查：在前后端日志里 grep 同一 TRACE=vt-…')
    voiceFeLog('会话', `前端已连接语音播报日志，目录：${dir} 前端文件：${fe}`)
    await flushVoiceFeLog()
  } catch {
    /* ignore */
  }
}

// 页面卸载尽量冲刷
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    void flushVoiceFeLog()
  })
}
