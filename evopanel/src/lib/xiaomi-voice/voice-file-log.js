/**
 * 小V「语音播报」调试日志（前端 → 后端落盘分文件）。
 *
 * 目录：logs/语音播报/
 *   - 前端-YYYY-MM-DD.log
 *   - 后端-YYYY-MM-DD.log
 *
 * TRACE：一轮提问→播报共用同一 ID；前后端每行都带 [TRACE=vt-…]，grep 即可串起来。
 * 核对阶段：流式正文 | 语音合成 | 语音播放 | 播放结束
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

function clip(s, n = 800) {
  const t = String(s || '')
    .replace(/\r/g, ' ')
    .replace(/\n/g, ' ')
    .trim()
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`
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
