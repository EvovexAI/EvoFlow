/**
 * Xiaomi Frame-runtime speech session client.
 * PCM up → partial/final/turn_end down; assistant_delta → TTS audio frames.
 */

import {
  getXiaomiAsrProvider,
  getXiaomiTtsProvider,
  getXiaomiTtsSpeaker,
  resolveXiaomiTtsSpeaker,
  setXiaomiTtsSpeaker,
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
/**
 * @typedef {{
 *   audio: HTMLAudioElement,
 *   ms: MediaSource,
 *   sb: SourceBuffer|null,
 *   pending: ArrayBuffer[],
 *   objectUrl: string,
 *   wireEnded: boolean,
 *   started: boolean,
 *   gotAudio?: boolean,
 *   _queuedAt?: number,
 *   _nearEndHandler?: (() => void) | null,
 *   _watchTimer?: number,
 *   _watchFromBuf?: number,
 *   _watchBufHandler?: (() => void) | null,
 * }} FramePlayEntry
 */
/** @type {Map<number, FramePlayEntry>} */
const _play = new Map()
/** 播报顺序（Pipecat：一次只出一声，按 seq 串行） */
/** @type {number[]} */
const _playOrder = []
/** @type {number | null} */
let _playingSeq = null
/** @type {((msg: Record<string, unknown>) => void) | null} */
let _onEvent = null
let _active = false
/** 本轮回复是否已记过「本地首次开播」（用于时效性） */
let _replyPlayLogged = false
/** @type {((info: { seq: number, at: number }) => void) | null} */
let _onFirstLocalPlay = null
/** @type {((idle: boolean) => void) | null} */
let _onPlaybackIdle = null
/** 本地停播后丢弃迟到 tts_*，直到下一轮 assistant_begin（白龙马 stopTTS 语义） */
let _dropIncomingAudio = false

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
          if (_dropIncomingAudio) return
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
      // 固定音色：永不空，避免多句分片落到不同默认说话人
      const speaker = resolveXiaomiTtsSpeaker()
      if (!getXiaomiTtsSpeaker()) setXiaomiTtsSpeaker(speaker)
      const tid = getVoiceTrace() || beginVoiceTrace({ reason: 'frame-session-start' })
      voiceFeLog(
        '会话',
        `WebSocket 已连接，发送 start ASR=${asr} TTS=${tts} 音色=${speaker} TRACE=${tid}`,
      )
      ws.send(
        JSON.stringify({
          type: 'start',
          asr_provider: asr,
          tts_provider: tts,
          trace_id: tid,
          speaker,
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
    if (_dropIncomingAudio) return
    const tid = String(m.trace_id || '').trim()
    if (tid) adoptVoiceTrace(tid, { reason: 'tts_start' })
    const seq = Number(m.seq) || 0
    if (seq) {
      // 首包进队即挂起 continuous（白龙马：整轮只 suspend 一次）
      if (_play.size === 0 && _playOrder.length === 0) {
        _notifyBgVoiceTts(true)
      }
      if (!_playOrder.includes(seq)) _playOrder.push(seq)
      _ensurePlayer(seq)
      _kickSerialPlay()
    }
  } else if (type === 'tts_end') {
    if (_dropIncomingAudio) return
    const seq = Number(m.seq) || 0
    _finishPlayer(seq, !!m.cancelled)
  } else if (type === 'interrupted') {
    _dropIncomingAudio = false
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
  /** @type {FramePlayEntry} */
  const entry = {
    audio,
    ms,
    sb: null,
    pending: [],
    objectUrl,
    wireEnded: false,
    started: false,
    gotAudio: false,
    _queuedAt: performance.now(),
  }
  _play.set(seq, entry)
  voiceFeLog('播报', `创建本地播放器（待串行开播） seq=${seq}`)
  ms.addEventListener('sourceopen', () => {
    try {
      entry.sb = ms.addSourceBuffer('audio/mpeg')
      entry.sb.addEventListener('updateend', () => {
        _flushPending(seq)
        _kickSerialPlay()
      })
    } catch {
      /* ignore */
    }
    _flushPending(seq)
    // 不在这里 play：等轮到本 seq，避免短句叠在长句上
    _kickSerialPlay()
  })
  return entry
}

function _appendAudio(seq, buf) {
  if (_dropIncomingAudio) return
  if (!_playOrder.includes(seq)) _playOrder.push(seq)
  const entry = _ensurePlayer(seq)
  if (!entry) return
  entry.gotAudio = true
  if (entry.sb && !entry.sb.updating) {
    try {
      entry.sb.appendBuffer(buf)
      _kickSerialPlay()
      return
    } catch {
      /* fallthrough */
    }
  }
  entry.pending.push(buf)
  _kickSerialPlay()
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

/**
 * MSE/流式 mp3 时常 duration=Infinity/NaN；用 SourceBuffer.buffered 估时长。
 * @param {FramePlayEntry} entry
 * @returns {number} seconds, 0 if unknown
 */
function _entryPlayableDuration(entry) {
  try {
    const dur = Number(entry.audio.duration)
    if (Number.isFinite(dur) && dur > 0 && dur < 3600) return dur
  } catch {
    /* ignore */
  }
  try {
    const b = entry.sb?.buffered
    if (b && b.length > 0) {
      const end = b.end(b.length - 1)
      if (Number.isFinite(end) && end > 0) return end
    }
  } catch {
    /* ignore */
  }
  return 0
}

/**
 * 只播队列头：上一句听完（或距结尾 <80ms）才开下一句。
 * 后端「播放结束」= 字节下发完，不等于用户听完。
 * 下一句若已缓冲，近尾预切可压低句间静音。
 */
function _kickSerialPlay() {
  if (_playingSeq != null) return
  while (_playOrder.length) {
    const seq = _playOrder[0]
    const entry = _play.get(seq)
    if (!entry) return
    if (!entry.sb) return
    // 必须有真实音频再 play。仅 wireEnded、无字节 → 空源会 Failed to load。
    const hasAudio =
      entry.pending.length > 0 ||
      (entry.sb.buffered && entry.sb.buffered.length > 0) ||
      !!entry.gotAudio
    if (!hasAudio) {
      if (entry.wireEnded && !entry.started) {
        voiceFeLog('播报', `跳过空句 seq=${seq}（tts_end 时仍无音频）`)
        _playOrder.shift()
        _disposeEntry(seq)
        continue
      }
      return
    }

    _playingSeq = seq
    entry.started = true
    try {
      _onPlaybackIdle?.(false)
    } catch {
      /* ignore */
    }
    // continuous / follow-up 必须知道 Frame 在播（pipeline 未挂 handler 时也曾漏 notify → 空闲误退下）
    _notifyBgVoiceTts(true)
    const prevGap =
      typeof entry._queuedAt === 'number' ? Math.round(performance.now() - entry._queuedAt) : null
    const playAt = performance.now()
    const wall = new Date().toISOString()
    voicePlaybackMark(
      '语音播放',
      '',
      `本地串行开播 seq=${seq} at=${wall}` +
        (prevGap != null ? ` wait_in_queue=${prevGap}ms` : ''),
    )
    if (!_replyPlayLogged) {
      _replyPlayLogged = true
      voiceFeLog(
        '时效',
        `本轮首次本地播报开始 seq=${seq} at=${wall}`,
      )
      try {
        _onFirstLocalPlay?.({ seq, at: playAt })
      } catch {
        /* ignore */
      }
    }
    void entry.audio.play().catch((err) => {
      voiceFeLog('播报', `audio.play 失败 seq=${seq}：${err?.message || err}`)
      _advanceAfterSeq(seq)
    })
    entry.audio.addEventListener(
      'ended',
      () => {
        voicePlaybackMark('播放结束', '', `本地播完 seq=${seq}`)
        _advanceAfterSeq(seq)
      },
      { once: true },
    )
    // 距结尾 80ms 预切下一句；duration 未知时用 buffered 估
    const onTime = () => {
      if (_playingSeq !== seq) return
      const dur = _entryPlayableDuration(entry)
      const cur = Number(entry.audio.currentTime)
      if (!(dur > 0) || !Number.isFinite(cur)) return
      // buffered 变长时刷新看门狗
      if (!entry._watchFromBuf || Math.abs(entry._watchFromBuf - dur) > 0.05) {
        entry._watchFromBuf = dur
        _armPlayWatchdog(seq, entry)
      }
      if (dur - cur <= 0.08) {
        entry.audio.removeEventListener('timeupdate', onTime)
        voicePlaybackMark(
          '播放结束',
          '',
          `本地近尾预切 seq=${seq} left=${((dur - cur) * 1000).toFixed(0)}ms`,
        )
        _advanceAfterSeq(seq)
      }
    }
    entry.audio.addEventListener('timeupdate', onTime)
    entry._nearEndHandler = onTime
    // 防卡死：MSE 短句常无 duration → 旧硬超时 12s 会整轮卡住（日志 seq=7）
    _armPlayWatchdog(seq, entry)
    return
  }
}

/** @param {number} seq @param {FramePlayEntry} entry */
function _armPlayWatchdog(seq, entry) {
  const clear = () => {
    if (entry._watchTimer) {
      window.clearTimeout(entry._watchTimer)
      entry._watchTimer = 0
    }
  }
  clear()
  const armFromDuration = () => {
    const dur = _entryPlayableDuration(entry)
    if (!(dur > 0)) return false
    const cur = Number(entry.audio.currentTime) || 0
    const leftMs = Math.max(200, Math.ceil((dur - cur) * 1000) + 250)
    clear()
    entry._watchTimer = window.setTimeout(() => {
      if (_playingSeq === seq) {
        voiceFeLog('播报', `本地播报看门狗推进 seq=${seq}（ended/近尾未触发） dur≈${dur.toFixed(2)}s`)
        _advanceAfterSeq(seq)
      }
    }, leftMs)
    return true
  }
  if (!armFromDuration()) {
    // wire 已结束仍无时长：短句常见，2.5s 内必须推进（勿再 12s）
    // wire 未结束：给合成/下发留余量，最多 6s
    const hardMs = entry.wireEnded ? 2500 : 6000
    entry._watchTimer = window.setTimeout(() => {
      if (_playingSeq !== seq) return
      // 到期再试一次 buffered
      if (armFromDuration()) return
      voiceFeLog(
        '播报',
        `本地播报硬超时推进 seq=${seq} wireEnded=${!!entry.wireEnded} limit=${hardMs}ms`,
      )
      _advanceAfterSeq(seq)
    }, hardMs)
    const onMeta = () => {
      if (_playingSeq === seq) armFromDuration()
    }
    entry.audio.addEventListener('loadedmetadata', onMeta)
    entry.audio.addEventListener('durationchange', onMeta)
    // MSE：append 完成后 buffered 才有值
    try {
      entry.sb?.addEventListener('updateend', onMeta)
      entry._watchBufHandler = onMeta
    } catch {
      /* ignore */
    }
  }
}

function _disposeEntry(seq) {
  const entry = _play.get(seq)
  if (!entry) return
  try {
    if (entry._watchTimer) {
      window.clearTimeout(entry._watchTimer)
      entry._watchTimer = 0
    }
  } catch {
    /* ignore */
  }
  try {
    if (entry._nearEndHandler) {
      entry.audio.removeEventListener('timeupdate', entry._nearEndHandler)
    }
  } catch {
    /* ignore */
  }
  try {
    if (entry._watchBufHandler && entry.sb) {
      entry.sb.removeEventListener('updateend', entry._watchBufHandler)
    }
  } catch {
    /* ignore */
  }
  try {
    entry.audio.pause()
  } catch {
    /* ignore */
  }
  try {
    if (entry.sb && entry.ms.readyState === 'open') entry.ms.endOfStream()
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

function _advanceAfterSeq(seq) {
  const idx = _playOrder.indexOf(seq)
  if (idx >= 0) _playOrder.splice(idx, 1)
  if (_playingSeq === seq) _playingSeq = null
  _disposeEntry(seq)
  _kickSerialPlay()
  _maybeNotifyListening()
}

/** 本地是否仍有待播 / 在播 */
export function isXiaomiFramePlaying() {
  return _playingSeq != null || _playOrder.length > 0 || _play.size > 0
}

/** 本地播放队列已空 → 通知后端可 unmute，下一轮才能识别 */
function _maybeNotifyListening() {
  if (isXiaomiFramePlaying()) return
  sendXiaomiClientListening()
  try {
    _onPlaybackIdle?.(true)
  } catch {
    /* ignore */
  }
  _notifyBgVoiceTts(false)
}

/** Frame 本地播报起止 → continuous 空闲计时 / ASR duck（不依赖 pipeline 是否挂了 handler） */
function _notifyBgVoiceTts(started) {
  void import('../background-voice.js')
    .then((m) => {
      if (started) m.notifyTTSStarted?.()
      else m.notifyTTSStopped?.()
    })
    .catch(() => {})
}

export function sendXiaomiClientListening() {
  if (!isXiaomiFrameSessionActive()) return
  try {
    _ws.send(JSON.stringify({ type: 'client_listening' }))
    voiceFeLog('管线', '本地播完 → 发送 client_listening（后端可 unmute）')
  } catch {
    /* ignore */
  }
}

/**
 * 注册本轮首次本地开播回调（pipeline 用来算 用户说完→播报 延迟）。
 * @param {((info: { seq: number, at: number }) => void) | null} fn
 */
export function setXiaomiFirstLocalPlayHandler(fn) {
  _onFirstLocalPlay = typeof fn === 'function' ? fn : null
}

/**
 * 本地播放队列空闲变化（pipeline 用来把 tray 从 speaking → listening）。
 * @param {((idle: boolean) => void) | null} fn
 */
export function setXiaomiPlaybackIdleHandler(fn) {
  _onPlaybackIdle = typeof fn === 'function' ? fn : null
}

/** 新一轮助手回复开始时复位「首次开播」标记 */
export function resetXiaomiReplyPlayMark() {
  _replyPlayLogged = false
}

function _finishPlayer(seq, cancelled) {
  const entry = _play.get(seq)
  if (!entry) {
    const idx = _playOrder.indexOf(seq)
    if (idx >= 0) _playOrder.splice(idx, 1)
    if (_playingSeq === seq) {
      _playingSeq = null
      _kickSerialPlay()
    }
    return
  }
  if (cancelled) {
    _advanceAfterSeq(seq)
    return
  }
  entry.wireEnded = true
  _flushPending(seq)
  try {
    if (entry.sb && !entry.sb.updating && entry.ms.readyState === 'open') {
      entry.ms.endOfStream()
    }
  } catch {
    /* ignore */
  }
  // 若还没轮到播，等 _kickSerialPlay；若正在播，重挂看门狗（wire 刚结束、duration 可能刚就绪）
  if (_playingSeq === seq) {
    _armPlayWatchdog(seq, entry)
  } else {
    _kickSerialPlay()
  }
}

function _teardownAllAudio() {
  _playingSeq = null
  _playOrder.length = 0
  for (const seq of [..._play.keys()]) {
    _disposeEntry(seq)
  }
  _replyPlayLogged = false
  // 打断后立刻可听下一轮
  sendXiaomiClientListening()
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
    _dropIncomingAudio = false
    // 新一轮开闸前清掉卡死的旧队列，否则永不 client_listening、残句叠播
    if (_playingSeq != null || _playOrder.length > 0 || _play.size > 0) {
      voiceFeLog('播报', 'assistant_begin → 清空上一轮未播完队列')
      _teardownAllAudio()
    } else {
      resetXiaomiReplyPlayMark()
    }
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
 * 白龙马式本地停播：只清 MSE 队列 + client_listening，**不**发 barge_in。
 * continuous 音量打断应走这里——发 barge_in 会抬 min_turn、掐掉整轮合成（回声误触日志 14:16）。
 * 真·新提问由下一轮 assistant_begin / 显式 bargeInXiaomiFrame 收口。
 * @param {{ reason?: string }} [opts]
 */
export function stopXiaomiFrameLocalPlayback(opts = {}) {
  const reason = String(opts.reason || 'local-stop')
  if (!isXiaomiFramePlaying() && _play.size === 0) return
  voiceFeLog('打断', `本地停播（不对后端 barge_in）reason=${reason}`)
  _dropIncomingAudio = true
  _teardownAllAudio()
  try {
    _onPlaybackIdle?.(true)
  } catch {
    /* ignore */
  }
  _notifyBgVoiceTts(false)
}

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
