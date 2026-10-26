/**
 * 小V Frame 语音相位（unmute / barge 唯一门控）。
 *
 *   idle → listening → thinking → speaking → listening
 *
 * 规则（对齐「艾薇」式边界，不抄声纹）：
 *   - 仅 listening 允许 client_listening → STT unmute
 *   - 仅 speaking 接受 vad_barge（思考期忽略，避免 abort 刚发出的 run）
 *   - document.hidden 时强制 hold（等同 thinking 门控），恢复后重算
 */

import { voiceDecisionLog, voiceFeLog } from './voice-file-log.js'

/** @typedef {'idle'|'listening'|'thinking'|'speaking'} VoicePhase */

/** @type {VoicePhase} */
let _phase = 'idle'
/** 锁屏/切后台：门控按 thinking，不改 tray 文案来源 */
let _hiddenHold = false
/** @type {Set<(phase: VoicePhase, prev: VoicePhase, reason: string) => void>} */
const _listeners = new Set()
/** @type {(() => void) | null} */
let _unsubVisibility = null

/**
 * @param {string} raw
 * @returns {VoicePhase}
 */
function _norm(raw) {
  const s = String(raw || '').trim().toLowerCase()
  if (s === 'idle' || s === 'listening' || s === 'thinking' || s === 'speaking') return s
  // tray 别名
  if (s === 'recording') return 'listening'
  if (s === 'processing' || s === 'running') return 'thinking'
  return 'idle'
}

/** 有效门控相位（含 hidden hold） */
export function getVoicePhase() {
  if (_hiddenHold && _phase !== 'idle') return 'thinking'
  return _phase
}

/** 裸相位（不含 hidden），给 tray / UI */
export function getVoicePhaseRaw() {
  return _phase
}

export function isVoicePhaseHiddenHold() {
  return _hiddenHold
}

/** 仅 listening 可 unmute STT */
export function canUnmuteStt() {
  return getVoicePhase() === 'listening'
}

/** 仅 speaking 接受 VAD 抢话打断 */
export function canAcceptVadBarge() {
  return getVoicePhase() === 'speaking'
}

/**
 * @param {{
 *   running?: boolean,
 *   playing?: boolean,
 *   awaitingReply?: boolean,
 *   sending?: boolean,
 *   pending?: number,
 * }} flags
 * @returns {VoicePhase}
 */
export function deriveVoicePhase(flags = {}) {
  if (!flags.running) return 'idle'
  if (flags.playing) return 'speaking'
  if (flags.sending || flags.awaitingReply || (flags.pending || 0) > 0) return 'thinking'
  return 'listening'
}

/**
 * @param {VoicePhase|string} next
 * @param {string} [reason]
 * @returns {boolean} 是否变化
 */
export function setVoicePhase(next, reason = '') {
  const n = _norm(next)
  if (n === _phase) return false
  const prev = _phase
  _phase = n
  voiceDecisionLog('phase', {
    from: prev,
    to: n,
    reason: reason || '-',
    gate: getVoicePhase(),
    hiddenHold: _hiddenHold ? 1 : 0,
  })
  voiceFeLog('决策', `相位 ${prev} → ${n}${reason ? ` reason=${reason}` : ''} gate=${getVoicePhase()}`)
  for (const fn of _listeners) {
    try {
      fn(n, prev, reason || '')
    } catch {
      /* ignore */
    }
  }
  return true
}

/**
 * @param {boolean} on
 * @param {string} [reason]
 */
export function setVoicePhaseHiddenHold(on, reason = '') {
  const next = !!on
  if (next === _hiddenHold) return
  _hiddenHold = next
  voiceDecisionLog('terminal_visibility', {
    hidden: next ? 1 : 0,
    reason: reason || '-',
    rawPhase: _phase,
    gate: getVoicePhase(),
  })
  voiceFeLog(
    '决策',
    `terminal_visibility hidden=${next ? 1 : 0}${reason ? ` reason=${reason}` : ''} gate=${getVoicePhase()}`,
  )
  // 通知订阅方同步后端 client_phase（门控相位变了）
  for (const fn of _listeners) {
    try {
      fn(_phase, _phase, reason || (next ? 'document_hidden' : 'document_visible'))
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {(phase: VoicePhase, prev: VoicePhase, reason: string) => void} fn
 * @returns {() => void}
 */
export function subscribeVoicePhase(fn) {
  if (typeof fn !== 'function') return () => {}
  _listeners.add(fn)
  return () => {
    _listeners.delete(fn)
  }
}

/** 管线启动时挂 visibility；停止时卸 */
export function installVoiceVisibilityTerminal() {
  if (typeof document === 'undefined') return () => {}
  if (_unsubVisibility) return _unsubVisibility
  const onVis = () => {
    if (document.hidden) setVoicePhaseHiddenHold(true, 'document_hidden')
    else setVoicePhaseHiddenHold(false, 'document_visible')
  }
  document.addEventListener('visibilitychange', onVis)
  _unsubVisibility = () => {
    document.removeEventListener('visibilitychange', onVis)
    _unsubVisibility = null
    if (_hiddenHold) setVoicePhaseHiddenHold(false, 'uninstall')
  }
  // 启动时若已在后台
  if (document.hidden) setVoicePhaseHiddenHold(true, 'document_hidden_initial')
  return _unsubVisibility
}

export function resetVoicePhase(reason = 'reset') {
  _hiddenHold = false
  setVoicePhase('idle', reason)
}
