/**
 * Xiaomi Frame-runtime speech session client.
 * PCM up → partial/final/turn_end down; assistant_delta → TTS audio frames.
 */

import {
  getXiaomiAsrProvider,
  getXiaomiTtsProvider,
  getXiaomiTtsSpeaker,
} from './config.js'
import {
  beginVoiceTrace,
  getVoiceTrace,
  setVoiceSid,
  adoptVoiceTrace,
  voiceFeLog,
  voicePlaybackMark,
} from './voice-file-log.js'

/** @type {WebSocket | null} */
let _ws = null
/** @type {Promise<WebSocket | null> | null} */
let _connecting = null
/** @type {Map<number, { audio: HTMLAudioElement, ms: MediaSource, sb: SourceBuffer|null, pending: ArrayBuffer[], objectUrl: string }>} */
const _play = new Map()
/** @type {((msg: Record<string, unknown>) => void) | null} */
let _onEvent = null
let _active = false

export function isXiaomiFrameSessionActive() {
  return !!(_ws && _ws.readyState === WebSocket.OPEN)
}

/** connectXiaomiFrameSession 进行中（尚未 OPEN） */
export function isXiaomiFrameSessionConnecting() {
  return !!_connecting
}

export function setXiaomiFrameEventHandler(fn) {
  _onEvent = typeof fn === 'function' ? fn : null
}

async function _sessionUrl() {
  const { speechAsrStreamUrl } = await import('../speech-client.js')
  const asr = await speechAsrStreamUrl()
  return asr.replace(/\/asr\/stream$/, '/session')
}

/**
 * @returns {Promise<WebSocket | null>}
 */
export async function connectXiaomiFrameSession() {
  if (isXiaomiFrameSessionActive()) return _ws
  if (_connecting) return _connecting
  _connecting = (async () => {
    try {
      const url = await _sessionUrl()
      const ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('session timeout')), 2500)
        ws.onopen = () => {
          clearTimeout(timer)
          resolve()
        }
        ws.onerror = () => {
          clearTimeout(timer)
          reject(new Error('session error'))
        }
      })
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          let m
          try {
            m = JSON.parse(ev.data)
          } catch {
            return
          }
          _handleJson(m)
          return
        }
        if (ev.data instanceof ArrayBuffer && ev.data.byteLength > 4) {
          const seq = new DataView(ev.data).getUint32(0, true)
          _appendAudio(seq, ev.data.slice(4))
        }
      }
      ws.onclose = () => {
        if (_ws === ws) _ws = null
        _active = false
        _teardownAllAudio()
      }
      _ws = ws
      _active = true
      const asr = getXiaomiAsrProvider()
      const tts = getXiaomiTtsProvider()
      const speaker = getXiaomiTtsSpeaker()
      const tid = getVoiceTrace() || beginVoiceTrace({ reason: 'frame-session-start' })
      voiceFeLog(
        '会话',
        `WebSocket 已连接，发送 start ASR=${asr} TTS=${tts}` +
          (speaker ? ` 音色=${speaker}` : '') +
          ` TRACE=${tid}`,
      )
      ws.send(
        JSON.stringify({
          type: 'start',
          asr_provider: asr,
          tts_provider: tts,
          trace_id: tid,
          ...(speaker ? { speaker } : {}),
        }),
      )
      return ws
    } catch (e) {
      voiceFeLog('会话', `WebSocket 连接失败：${e?.message || e}`)
      console.warn('[xiaomi-frame] connect failed', e)
      _ws = null
      _active = false
      return null
    } finally {
      _connecting = null
    }
  })()
  return _connecting
}

function _handleJson(m) {
  const type = String(m?.type || '')
  if (type === 'ready' || type === 'trace' || type === 'turn_end') {
    const tid = String(m.trace_id || '').trim()
    const sid = String(m.sid || '').trim()
    if (sid) setVoiceSid(sid)
    if (tid) {
      adoptVoiceTrace(tid, {
        sid,
        reason: type === 'turn_end' ? '后端 turn_end' : type === 'ready' ? 'session ready' : '后端 trace',
      })
    } else if (sid && type === 'ready') {
      setVoiceSid(sid)
      voiceFeLog('会话', `Frame ready SID=${sid}`)
    }
  }
  if (type === 'tts_start') {
    const tid = String(m.trace_id || '').trim()
    if (tid) adoptVoiceTrace(tid, { reason: 'tts_start' })
    const seq = Number(m.seq) || 0
    if (seq) _ensurePlayer(seq)
  } else if (type === 'tts_end') {
    const seq = Number(m.seq) || 0
    _finishPlayer(seq, !!m.cancelled)
  } else if (type === 'interrupted') {
    _teardownAllAudio()
  }
  try {
    _onEvent?.(m)
  } catch {
    /* ignore */
  }
}

function _ensurePlayer(seq) {
  if (_play.has(seq)) return _play.get(seq)
  const MS = window.MediaSource
  if (!MS || !MS.isTypeSupported('audio/mpeg')) {
    voiceFeLog('播报', `无法创建播放器 seq=${seq}（浏览器不支持 MediaSource/mpeg）`)
    return null
  }
  const ms = new MS()
  const objectUrl = URL.createObjectURL(ms)
  const audio = new Audio(objectUrl)
  /** @type {{ audio: HTMLAudioElement, ms: MediaSource, sb: SourceBuffer|null, pending: ArrayBuffer[], objectUrl: string }} */
  const entry = { audio, ms, sb: null, pending: [], objectUrl }
  _play.set(seq, entry)
  voiceFeLog('播报', `创建本地播放器，准备播报音频 seq=${seq}`)
  ms.addEventListener('sourceopen', () => {
    try {
      entry.sb = ms.addSourceBuffer('audio/mpeg')
      entry.sb.addEventListener('updateend', () => _flushPending(seq))
    } catch {
      /* ignore */
    }
    void audio.play().catch((err) => {
      voiceFeLog('播报', `audio.play 失败 seq=${seq}：${err?.message || err}`)
    })
  })
  return entry
}

function _appendAudio(seq, buf) {
  const entry = _ensurePlayer(seq)
  if (!entry) return
  if (entry.sb && !entry.sb.updating) {
    try {
      entry.sb.appendBuffer(buf)
      return
    } catch {
      /* fallthrough */
    }
  }
  entry.pending.push(buf)
}

function _flushPending(seq) {
  const entry = _play.get(seq)
  if (!entry?.sb) return
  while (!entry.sb.updating && entry.pending.length) {
    try {
      entry.sb.appendBuffer(entry.pending.shift())
      return
    } catch {
      break
    }
  }
}

function _finishPlayer(seq, cancelled) {
  const entry = _play.get(seq)
  if (!entry) return
  const close = () => {
    try {
      if (entry.sb && entry.ms.readyState === 'open') entry.ms.endOfStream()
    } catch {
      /* ignore */
    }
  }
  if (cancelled) {
    try {
      entry.audio.pause()
    } catch {
      /* ignore */
    }
    close()
    URL.revokeObjectURL(entry.objectUrl)
    _play.delete(seq)
    return
  }
  _flushPending(seq)
  entry.audio.addEventListener(
    'ended',
    () => {
      close()
      URL.revokeObjectURL(entry.objectUrl)
      _play.delete(seq)
    },
    { once: true },
  )
  // If already ended / never started, clean soon
  setTimeout(() => {
    if (_play.get(seq) === entry && entry.audio.ended) {
      close()
      URL.revokeObjectURL(entry.objectUrl)
      _play.delete(seq)
    }
  }, 50)
}

function _teardownAllAudio() {
  for (const [seq, entry] of _play) {
    try {
      entry.audio.pause()
    } catch {
      /* ignore */
    }
    try {
      URL.revokeObjectURL(entry.objectUrl)
    } catch {
      /* ignore */
    }
    _play.delete(seq)
  }
}

export function sendXiaomiPcm(pcm) {
  if (!isXiaomiFrameSessionActive() || !pcm) return
  try {
    _ws.send(pcm)
  } catch {
    /* ignore */
  }
}

export function flushXiaomiAsr() {
  if (!isXiaomiFrameSessionActive()) return
  try {
    _ws.send(JSON.stringify({ type: 'flush' }))
  } catch {
    /* ignore */
  }
}

export function sendXiaomiAssistantBegin() {
  if (!isXiaomiFrameSessionActive()) return false
  try {
    let tid = getVoiceTrace()
    if (!tid) tid = beginVoiceTrace({ reason: 'assistant_begin' })
    _ws.send(JSON.stringify({ type: 'assistant_begin', trace_id: tid }))
    voicePlaybackMark('流式正文', '', `assistant_begin → Frame TRACE=${tid}`)
    return true
  } catch {
    return false
  }
}

export function sendXiaomiAssistantDelta(text) {
  if (!isXiaomiFrameSessionActive() || !text) return false
  try {
    // 细粒度流式正文由 feedXiaomiFrameAssistant / 后端 session 记，避免每个 token 刷屏
    _ws.send(JSON.stringify({ type: 'assistant_delta', text: String(text) }))
    return true
  } catch {
    return false
  }
}

export function sendXiaomiAssistantEnd() {
  if (!isXiaomiFrameSessionActive()) return false
  try {
    _ws.send(JSON.stringify({ type: 'assistant_end' }))
    voicePlaybackMark(
      '流式正文',
      '',
      `assistant_end → Frame（冲刷残句） TRACE=${getVoiceTrace() || '-'}`,
    )
    return true
  } catch {
    return false
  }
}

/** @type {number} */
let _lastBargeAt = 0
/** @type {string} */
let _lastBargeReason = ''

/**
 * @param {{ reason?: string }} [opts]
 */
export function bargeInXiaomiFrame(opts = {}) {
  if (!isXiaomiFrameSessionActive()) return
  const reason = String(opts.reason || 'client_barge_in')
  const now = Date.now()
  // 200ms 内同因去重：continuous 回声会连打几十次 stopTTS/barge
  if (now - _lastBargeAt < 200 && reason === _lastBargeReason) {
    return
  }
  _lastBargeAt = now
  _lastBargeReason = reason
  const tid = getVoiceTrace()
  voiceFeLog(
    '打断',
    `发送 barge_in reason=${reason}，清空本地播放队列${tid ? ` TRACE=${tid}` : ''}`,
  )
  try {
    _ws.send(
      JSON.stringify({
        type: 'barge_in',
        reason,
        ...(tid ? { trace_id: tid } : {}),
      }),
    )
  } catch {
    /* ignore */
  }
  _teardownAllAudio()
}

export function stopXiaomiFrameSession() {
  if (_active) voiceFeLog('会话', '关闭 Frame session')
  bargeInXiaomiFrame()
  try {
    _ws?.send(JSON.stringify({ type: 'stop' }))
  } catch {
    /* ignore */
  }
  try {
    _ws?.close()
  } catch {
    /* ignore */
  }
  _ws = null
  _active = false
}

export function isXiaomiFrameRuntimePreferred() {
  return _active && isXiaomiFrameSessionActive()
}
