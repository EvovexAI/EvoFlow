/**
 * 语音回复播报策略：简短确认 → 流式按句播报（ack 期间预取正文）→ 工具执行中静音+状态语 → 结论短播。
 * 持续监听模式下，播报开始/结束会通知 continuous policy 启动 barge-in 检测。
 */

import { flattenStreamDisplayText, isToolRunning } from './chat-normalize.js'
import { rowHasPendingApprovalTools } from './tool-approval.js'
import {
  appendStreamingSpeech,
  discardUnplayedStreamingSpeech,
  finalFlushStreamingSpeech,
  hasStreamingSpeechRemaining,
  holdStreamingSpeechPlayback,
  plainTextForSpeech,
  releaseStreamingSpeechPlayback,
  setSpeechQueueIdleCallback,
} from './speech-client.js'

/** 进入工具执行时播一次，避免长时间死寂 */
const VOICE_WORKING_STATUS_POOL = [
  '我处理一下',
  '稍等，我查一下',
  '正在处理',
  '我弄一下',
]

function pickVoiceWorkingStatusText() {
  return VOICE_WORKING_STATUS_POOL[Math.floor(Math.random() * VOICE_WORKING_STATUS_POOL.length)]
}

// ─── 持续监听 barge-in 通知钩子 ───
/** @type {(() => void) | null} */
let _onTTSStartCb = null
/** @type {(() => void) | null} */
let _onTTSStopCb = null

/**
 * @param {{ onStart?: () => void, onStop?: () => void }} cbs
 */
export function setTTSNotifyCallbacks(cbs = {}) {
  _onTTSStartCb = cbs.onStart || null
  _onTTSStopCb = cbs.onStop || null
  setSpeechQueueIdleCallback(() => {
    _onTTSStopCb?.()
  })
}

export function clearTTSNotifyCallbacks() {
  _onTTSStartCb = null
  _onTTSStopCb = null
  setSpeechQueueIdleCallback(null)
}

/** @type {(() => void) | null} */
let _resolveVoiceAck = null
/** @type {Promise<void>} */
let _voiceAckReady = Promise.resolve()

export function resetVoiceAckBarrier() {
  _voiceAckReady = new Promise((resolve) => {
    _resolveVoiceAck = resolve
  })
}

export function whenVoiceAckReady() {
  return _voiceAckReady
}

function completeVoiceAckBarrier() {
  if (_resolveVoiceAck) {
    _resolveVoiceAck()
    _resolveVoiceAck = null
  }
}

/** @type {boolean} */
let _voiceAckInFlight = false

/** @type {boolean} */
let _toolMuteActive = false
/** @type {boolean} */
let _toolStatusSpoken = false

/** 新语音轮开始时重置工具静音状态 */
export function resetVoiceToolMuteState() {
  _toolMuteActive = false
  _toolStatusSpoken = false
}

export function isVoiceToolMuteActive() {
  return _toolMuteActive
}

/**
 * 进入工具干活阶段：丢掉未播的「我将要…」预告，播一句短状态（每轮最多一次）。
 * @param {(state: 'speaking' | 'running') => void | Promise<void>} [onTrayState]
 */
export function enterVoiceToolMute(onTrayState) {
  if (_toolMuteActive) return
  _toolMuteActive = true
  discardUnplayedStreamingSpeech()
  if (onTrayState) void onTrayState('running')
  if (_toolStatusSpoken) return
  _toolStatusSpoken = true
  void (async () => {
    try {
      _onTTSStartCb?.()
      const { playAssistantSpeech } = await import('./speech-client.js')
      if (onTrayState) void onTrayState('speaking')
      await playAssistantSpeech(pickVoiceWorkingStatusText())
    } catch (e) {
      console.warn('[voice-reply-speech] working status failed', e)
    } finally {
      _onTTSStopCb?.()
      if (onTrayState) void onTrayState('running')
    }
  })()
}

/** 工具结束，允许继续播结论 */
export function exitVoiceToolMute() {
  _toolMuteActive = false
}

/**
 * 用户说完后的固定短确认——已关闭（每轮「好的/收到」太吵）。
 * 保留 API：立刻放行 ack barrier，不挡正文预取。
 * @param {(state: 'speaking' | 'running') => void | Promise<void>} [onTrayState]
 */
export async function playVoiceSimpleAck(onTrayState) {
  completeVoiceAckBarrier()
  if (onTrayState) void onTrayState('running')
}

/**
 * @param {(state: 'speaking' | 'running') => void | Promise<void>} [onTrayState]
 */
export function startVoiceSimpleAck(onTrayState) {
  resetVoiceToolMuteState()
  completeVoiceAckBarrier()
  if (onTrayState) void onTrayState('running')
}

/**
 * 工具执行或等待授权时暂停语音（中间「干活」阶段不播报）。
 * @param {unknown[]} tools
 */
export function shouldMuteVoiceSpeech(tools) {
  const list = Array.isArray(tools) ? tools : []
  if (rowHasPendingApprovalTools(list)) return true
  return list.some((t) => isToolRunning(t))
}

/**
 * @param {unknown[] | undefined} segments
 * @param {string | undefined} text
 */
export function extractVoiceSpeechText(segments, text) {
  return String(flattenStreamDisplayText(segments || [], text || '') || '').trim()
}

/**
 * @param {{
 *   hostedCaptureText?: string
 *   segments?: unknown[]
 *   text?: string
 *   canonicalOutText?: string
 * }} parts
 */
export function resolveVoiceSpeechBodyFromParts(parts = {}) {
  const hosted = String(parts.hostedCaptureText || '').trim()
  if (hosted) return hosted
  const fromStream = extractVoiceSpeechText(parts.segments, parts.text)
  if (fromStream) return fromStream
  return String(parts.canonicalOutText || parts.text || '').trim()
}

/** @param {string} rawBody */
export function toVoiceSpeechPlain(rawBody) {
  return plainTextForSpeech(String(rawBody || '').trim())
}

/**
 * 语音可播裁剪：避免长文整段朗读，但须覆盖完整短答（勿只念开场一句）。
 * 默认约 6 句 / 400 字；下一句超预算时截断补入，而不是直接丢掉。
 * @param {string} rawBody
 * @param {{ maxChars?: number, maxSentences?: number }} [opts]
 */
export function clipVoiceSpeechForPlayback(rawBody, opts = {}) {
  const plain = toVoiceSpeechPlain(rawBody)
  if (!plain) return ''
  const maxChars = Math.max(40, Number(opts.maxChars) || 400)
  const maxSentences = Math.max(1, Number(opts.maxSentences) || 6)
  if (plain.length <= maxChars) return plain

  // COMPAT(macOS12-JSC): no lookbehind — split after sentence punctuation, keep delimiter.
  const parts = []
  {
    const ends = '。！？!?；;'
    let start = 0
    for (let i = 0; i < plain.length; i++) {
      if (ends.includes(plain[i])) {
        const part = plain.slice(start, i + 1).trim()
        if (part) parts.push(part)
        start = i + 1
      }
    }
    const tail = plain.slice(start).trim()
    if (tail) parts.push(tail)
  }
  if (!parts.length) return plain.slice(0, maxChars)

  let out = ''
  for (let i = 0; i < parts.length && i < maxSentences; i++) {
    const part = parts[i]
    const next = out ? `${out}${part}` : part
    if (next.length <= maxChars) {
      out = next
      continue
    }
    // 下一句超预算：截断补入，避免只播「好的。」这类开场短句就停
    const remain = maxChars - out.length
    if (remain >= 12) {
      out = `${out}${part.slice(0, remain)}`
    } else if (!out) {
      out = part.slice(0, maxChars)
    }
    break
  }
  return out || plain.slice(0, maxChars)
}

/**
 * @param {string} nextRawBody
 * @param {string} lastSyncedPlain
 */
export function shouldAdvanceVoiceSpeechSync(nextRawBody, lastSyncedPlain) {
  const nextPlain = toVoiceSpeechPlain(clipVoiceSpeechForPlayback(nextRawBody))
  if (!nextPlain) return false
  const prev = String(lastSyncedPlain || '').trim()
  if (!prev) return true
  if (nextPlain === prev) return false
  return nextPlain.startsWith(prev)
}

/**
 * LEGACY：前台 HTTP 逐句队列。小V正文播报已改走 Frame（Pipecat：后端分句 TTS）。
 * 仅保留给非小V / 调试回退；正常 arm/sync 不再调用。
 * @param {string} text
 */
export function enqueueVoiceStreamSpeech(text) {
  if (_toolMuteActive) {
    void import('./xiaomi-voice-defaults.js')
      .then(({ xiaomiVoiceLog }) => xiaomiVoiceLog('enqueue SKIP: toolMuteActive'))
      .catch(() => {})
    void import('./xiaomi-voice/voice-file-log.js')
      .then(({ voicePlaybackMark }) => voicePlaybackMark('流式正文', '', 'enqueue 跳过：工具静音中'))
      .catch(() => {})
    return
  }
  const t = clipVoiceSpeechForPlayback(text)
  if (!t) return
  void import('./xiaomi-voice-defaults.js')
    .then(({ xiaomiVoiceDebug }) =>
      xiaomiVoiceDebug('enqueue → Gateway TTS', JSON.stringify(t.slice(0, 40))),
    )
    .catch(() => {})
  void import('./xiaomi-voice/voice-file-log.js')
    .then(({ voicePlaybackMark }) =>
      voicePlaybackMark('流式正文', t, `enqueue 入队 ${t.length} 字（legacy HTTP TTS）`),
    )
    .catch(() => {})
  _onTTSStartCb?.()
  appendStreamingSpeech(t)
}

/**
 * 流式结束：补播裁剪后的尾巴。
 * @param {string} text
 * @returns {boolean}
 */
export function flushVoiceStreamSpeechIfNeeded(text) {
  if (_toolMuteActive) exitVoiceToolMute()
  const t = clipVoiceSpeechForPlayback(text)
  if (!t) return false
  // 即使游标已到末尾，也要 kick 未播句（ack hold / stopTTS 丢句后可能卡住）
  const needTail = hasStreamingSpeechRemaining(t)
  _onTTSStartCb?.()
  const ok = finalFlushStreamingSpeech(t)
  void import('./xiaomi-voice/voice-file-log.js')
    .then(({ voicePlaybackMark }) =>
      voicePlaybackMark(
        '流式正文',
        t,
        `finalFlush needTail=${needTail} ok=${ok} chars=${t.length}`,
      ),
    )
    .catch(() => {})
  return ok || needTail
}

/**
 * @deprecated 请改用 flushVoiceStreamSpeechIfNeeded
 * @param {string} text
 */
export function flushVoiceStreamSpeech(text) {
  return flushVoiceStreamSpeechIfNeeded(text)
}
