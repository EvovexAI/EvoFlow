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
  voiceDecisionLog,
} from './voice-file-log.js'
import { canUnmuteStt, getVoicePhase, subscribeVoicePhase } from './voice-phase.js'

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
/** 已推进完的 seq：迟到二进制不得再 _ensurePlayer 复活（否则截尾+重播=卡顿漏词） */
/** @type {Set<number>} */
const _finishedSeqs = new Set()
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
/** 确认句播完但正文未到：延后 client_listening，避免思考期 unmute 误 barge */
/** @type {(() => boolean) | null} */
let _shouldDeferListening = null
/** 本地停播后丢弃迟到 tts_*，直到下一轮 assistant_begin（白龙马 stopTTS 语义） */
let _dropIncomingAudio = false
/** 相位 → 后端 client_phase 同步 */
let _phaseUnsub = null
let _lastSentPhase = ''
/** 是否已向当前 WS 发送过 start（等 ready 后再发，避免 start 建管线失败直接掐连接） */
let _startSent = false
/** @type {{ asr: string, tts: string, speaker: string, tid: string } | null} */
let _pendingStart = null

function _ensurePhaseWire() {
  if (_phaseUnsub) return
  // 只同步 client_phase；unmute 仍走 _maybeNotifyListening（避免 hidden→visible 抢跑）
  _phaseUnsub = subscribeVoicePhase(() => {
    sendXiaomiClientPhase(getVoicePhase())
  })
}

function _sendStartIfNeeded(reason = 'ready') {
  if (_startSent || !_pendingStart || !isXiaomiFrameSessionActive()) return
  const { asr, tts, speaker, tid } = _pendingStart
  _startSent = true
  try {
    _ws.send(
      JSON.stringify({
        type: 'start',
        asr_provider: asr,
        tts_provider: tts,
        trace_id: tid,
        speaker,
      }),
    )
    voiceFeLog(
      '会话',
      `发送 start（${reason}）ASR=${asr} TTS=${tts} 音色=${speaker} TRACE=${tid}`,
    )
  } catch (e) {
    _startSent = false
    voiceFeLog('会话', `发送 start 失败：${e?.message || e}`)
  }
}

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
      voiceFeLog('会话', `正在连接 Frame session ${String(url).replace(/\?.*/, '?…')}`)
      const ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'
      // 必须在 open 前挂好 handler，否则 ready 帧会丢（随后永远不发 start）
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
      ws.onclose = (ev) => {
        voiceFeLog(
          '会话',
          `Frame WS onclose code=${ev?.code ?? '?'} reason=${ev?.reason || '-'} wasClean=${ev?.wasClean ? 1 : 0} startSent=${_startSent ? 1 : 0}`,
        )
        if (_ws === ws) _ws = null
        _active = false
        _startSent = false
        _teardownAllAudio()
      }
      ws.onerror = () => {
        voiceFeLog('会话', 'Frame WS onerror（随后通常有 onclose）')
      }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('session timeout')), 2500)
        ws.onopen = () => {
          clearTimeout(timer)
          resolve()
        }
        const prevErr = ws.onerror
        ws.onerror = () => {
          clearTimeout(timer)
          try {
            prevErr?.()
          } catch {
            /* ignore */
          }
          reject(new Error('session error'))
        }
      })
      _ws = ws
      _active = true
      _lastSentPhase = ''
      _startSent = false
      _ensurePhaseWire()
      const asr = getXiaomiAsrProvider()
      const tts = getXiaomiTtsProvider()
      // 固定音色：永不空，避免多句分片落到不同默认说话人
      const speaker = resolveXiaomiTtsSpeaker()
      if (!getXiaomiTtsSpeaker()) setXiaomiTtsSpeaker(speaker)
      const tid = getVoiceTrace() || beginVoiceTrace({ reason: 'frame-session-start' })
      _pendingStart = { asr, tts, speaker, tid }
      voiceFeLog(
        '会话',
        `WebSocket 已连接，等待 ready 再 start ASR=${asr} TTS=${tts} 音色=${speaker} TRACE=${tid}`,
      )
      // ready 可能已先到（handler 已挂）→ 立刻 start；否则等 ready 回调
      _sendStartIfNeeded('connected')
      // 正文常在 connecting 期间被 stash；连上后必须冲刷，否则有字无声、台账空
      try {
        const { flushXiaomiFrameAssistantStash } = await import('./pipeline-client.js')
        flushXiaomiFrameAssistantStash?.()
      } catch {
        /* ignore */
      }
      return ws
    } catch (e) {
      voiceFeLog('会话', `WebSocket 连接失败：${e?.message || e}`)
      console.warn('[xiaomi-frame] connect failed', e)
      _ws = null
      _active = false
      _startSent = false
      _pendingStart = null
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
    if (type === 'ready') {
      voiceFeLog('会话', `收到 session ready SID=${sid || '-'} → 发送 start`)
      _sendStartIfNeeded('session_ready')
    }
  }
  if (type === 'error') {
    voiceFeLog(
      '错误',
      `Frame 后端 error：${String(m.message || m.error || JSON.stringify(m)).slice(0, 400)}`,
    )
    // start 失败时允许重发一次
    if (String(m.op || '') === 'start') {
      _startSent = false
      voiceFeLog('会话', 'start 失败 → 300ms 后重发 start')
      window.setTimeout(() => _sendStartIfNeeded('retry_after_error'), 300)
    }
  }
  if (type === 'partial' || type === 'final') {
    const t = String(m.text || '').trim()
    if (t) {
      voiceFeLog(
        '语音转文字',
        `${type === 'final' ? 'ASR最终' : 'ASR中间'}：「${t.slice(0, 120)}」`,
      )
    }
  }
  if (type === 'tts_start') {
    if (_dropIncomingAudio) return
    const tid = String(m.trace_id || '').trim()
    if (tid) adoptVoiceTrace(tid, { reason: 'tts_start' })
    const seq = Number(m.seq) || 0
    if (seq) {
      if (_finishedSeqs.has(seq)) {
        voiceFeLog('播报', `忽略已结束 seq 的迟到 tts_start seq=${seq}`)
        return
      }
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
    // 不在这里 unmute：思考期误 barge 应由 pipeline 保持 thinking；
    // 真打断由 pipeline _refreshTray → listening → flushXiaomiClientListeningIfIdle。
  }
  try {
    _onEvent?.(m)
  } catch {
    /* ignore */
  }
}

function _ensurePlayer(seq) {
  if (_finishedSeqs.has(seq)) return null
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
  // 已近尾推进的句：迟到字节勿复活播放器（日志里截尾后再播半句=卡顿漏词）
  if (_finishedSeqs.has(seq)) return
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

/** 本地播报状态回传台账（playing / played），不挡主路径。 */
function _sendPlaybackAck(seq, phase, extra = {}) {
  if (!isXiaomiFrameSessionActive() || !seq) return
  try {
    const tid = getVoiceTrace() || ''
    _ws.send(
      JSON.stringify({
        type: 'playback',
        phase,
        seq: Number(seq),
        trace_id: tid,
        utterance_id: tid ? `${tid}:${Number(seq)}` : '',
        ...extra,
      }),
    )
  } catch {
    /* ignore */
  }
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
    entry._playStartedAt = performance.now()
    _sendPlaybackAck(seq, 'playing')
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
        if (_playingSeq !== seq) return
        voicePlaybackMark('播放结束', '', `本地播完 seq=${seq}`)
        _advanceAfterSeq(seq)
      },
      { once: true },
    )
    // MSE/mpeg 常不触发 ended：wire 收齐后再近尾推进；未 wireEnded 绝不用 buffered 尾预切
    // （旧 150ms+hasNext 会在下一句已排队时截掉本句末尾 → 卡顿/漏词，见 16:01 日志）
    let raf = 0
    const tickNearEnd = () => {
      if (_playingSeq !== seq) return
      const dur = _entryPlayableDuration(entry)
      const cur = Number(entry.audio.currentTime)
      if (dur > 0 && Number.isFinite(cur)) {
        if (!entry._watchFromBuf || Math.abs(entry._watchFromBuf - dur) > 0.05) {
          entry._watchFromBuf = dur
          _armPlayWatchdog(seq, entry)
        }
        const wireDone =
          !!entry.wireEnded && !(entry.pending && entry.pending.length) && !entry.sb?.updating
        if (!wireDone) {
          raf = requestAnimationFrame(tickNearEnd)
          return
        }
        // wire 已齐：句间可短切；最后一句多留一点，避免近尾预切后立刻放麦把自己录进去
        const hasNext = _playOrder.some((s) => s !== seq)
        const lead = hasNext ? 0.04 : 0.22
        if (dur - cur <= lead) {
          const leftMs = Math.round((dur - cur) * 1000)
          voiceDecisionLog('advance_near_tail', {
            seq,
            leftMs,
            hasNext,
            leadMs: Math.round(lead * 1000),
            queue: _playOrder.length,
            wireEnded: true,
          })
          voicePlaybackMark(
            '播放结束',
            '',
            `本地近尾预切 seq=${seq} left=${leftMs}ms wireEnded=1`,
          )
          _advanceAfterSeq(seq)
          return
        }
      }
      raf = requestAnimationFrame(tickNearEnd)
    }
    raf = requestAnimationFrame(tickNearEnd)
    entry._nearEndRaf = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    }
    entry._nearEndHandler = null
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
    // wire 未齐时 buffered 尾会继续涨，按当前 dur 推进会截词
    if (!entry.wireEnded) return false
    const dur = _entryPlayableDuration(entry)
    if (!(dur > 0)) return false
    const cur = Number(entry.audio.currentTime) || 0
    // +80ms 余量即可；旧 +250ms 叠在「ended 不触发」上，句间空档听感像卡碟
    const leftMs = Math.max(120, Math.ceil((dur - cur) * 1000) + 80)
    clear()
    entry._watchTimer = window.setTimeout(() => {
      if (_playingSeq === seq) {
        if (!entry.wireEnded) {
          _armPlayWatchdog(seq, entry)
          return
        }
        const curNow = Number(entry.audio.currentTime) || 0
        voiceDecisionLog('advance_watchdog', {
          seq,
          dur: Number(dur.toFixed(2)),
          cur: Number(curNow.toFixed(2)),
          leftMs: Math.round((dur - curNow) * 1000),
          queue: _playOrder.length,
          wireEnded: true,
        })
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
    if (typeof entry._nearEndRaf === 'function') entry._nearEndRaf()
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
  const inOrder = _playOrder.includes(seq)
  const wasPlaying = _playingSeq === seq
  const hasEntry = _play.has(seq)
  // 近尾预切与 ended 常双触；第二次直接忽略
  if (!inOrder && !wasPlaying && !hasEntry) return
  const entry = _play.get(seq)
  let durationMs = 0
  if (entry && typeof entry._playStartedAt === 'number') {
    durationMs = Math.max(0, Math.round(performance.now() - entry._playStartedAt))
  }
  if (wasPlaying || entry?.started) {
    _sendPlaybackAck(seq, 'played', { duration_ms: durationMs })
  }
  const idx = _playOrder.indexOf(seq)
  if (idx >= 0) _playOrder.splice(idx, 1)
  if (_playingSeq === seq) _playingSeq = null
  if (seq) _finishedSeqs.add(seq)
  _disposeEntry(seq)
  _kickSerialPlay()
  // 仅整轮播完才 client_listening。句间也 unmute → 麦收喇叭 → 卡顿/误 barge
  if (_playingSeq == null && _playOrder.length === 0 && _play.size === 0) {
    _maybeNotifyListening()
  }
}

/** 本地是否仍有待播 / 在播 */
export function isXiaomiFramePlaying() {
  return _playingSeq != null || _playOrder.length > 0 || _play.size > 0
}

/** 本地播放队列已空 → 通知后端可 unmute，下一轮才能识别 */
function _maybeNotifyListening() {
  if (isXiaomiFramePlaying()) return
  try {
    _onPlaybackIdle?.(true)
  } catch {
    /* ignore */
  }
  _notifyBgVoiceTts(false)
  const deferred = _shouldDeferListening?.() || !canUnmuteStt()
  if (deferred) {
    voiceDecisionLog('defer_client_listening', {
      playing: false,
      deferred: true,
      phase: getVoicePhase(),
      legacyDefer: !!_shouldDeferListening?.(),
    })
    voiceFeLog(
      '管线',
      `本地队列空但延后 client_listening（phase=${getVoicePhase()}，等正文/思考结束）`,
    )
    return
  }
  voiceDecisionLog('send_client_listening', {
    playing: false,
    deferred: false,
    phase: getVoicePhase(),
  })
  sendXiaomiClientListening()
}

/** 正文 assistant_end 后若本地已空，补发被 defer 的 listening */
export function flushXiaomiClientListeningIfIdle() {
  if (isXiaomiFramePlaying()) return
  if (_shouldDeferListening?.() || !canUnmuteStt()) return
  sendXiaomiClientListening()
}

/**
 * @param {(() => boolean) | null} fn 返回 true 则暂不发 client_listening
 */
export function setXiaomiDeferClientListening(fn) {
  _shouldDeferListening = typeof fn === 'function' ? fn : null
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

/**
 * @param {{ force?: boolean }} [opts] force=真打断后必须放麦
 */
export function sendXiaomiClientListening(opts = {}) {
  if (!isXiaomiFrameSessionActive()) {
    voiceDecisionLog('skip_client_listening', {
      reason: 'ws_inactive',
      readyState: _ws ? _ws.readyState : -1,
      force: opts.force ? 1 : 0,
    })
    return
  }
  // 相位门控：非 listening 一律不放麦（后端也会再挡一层）；force 仅用于真打断收口
  if (!opts.force && !canUnmuteStt()) {
    voiceDecisionLog('block_client_listening', { phase: getVoicePhase() })
    return
  }
  try {
    _ws.send(JSON.stringify({ type: 'client_listening' }))
    voiceFeLog(
      '管线',
      `发送 client_listening（后端可 unmute） phase=${getVoicePhase()}${opts.force ? ' force=1' : ''}`,
    )
  } catch (e) {
    voiceFeLog('管线', `发送 client_listening 失败：${e?.message || e}`)
  }
}

/**
 * 若模块级 _ws 被误清、但 connect 返回的 socket 仍 OPEN，重新挂回。
 * @param {WebSocket | null | undefined} ws
 */
export function adoptXiaomiFrameSocket(ws) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  if (_ws !== ws) {
    voiceFeLog('会话', `adopt Frame socket（_ws 曾=${_ws ? _ws.readyState : -1} → OPEN）`)
    _ws = ws
    _active = true
  }
  return true
}

/**
 * 管线 ready / 恢复聆听：强制 phase=listening + client_listening（带诊断，不静默）。
 * @param {string} [reason]
 * @param {WebSocket | null} [wsHint] connect() 返回的 socket，优先于模块 _ws
 * @returns {boolean}
 */
export function forceXiaomiOpenMic(reason = 'open_mic', wsHint = null) {
  if (wsHint) adoptXiaomiFrameSocket(wsHint)
  const sock = _ws && _ws.readyState === WebSocket.OPEN ? _ws : wsHint
  const state = sock ? sock.readyState : -1
  if (!sock || state !== WebSocket.OPEN) {
    voiceDecisionLog('force_open_mic_fail', { reason, readyState: state })
    voiceFeLog('决策', `forceOpenMic 失败 reason=${reason} readyState=${state}`)
    return false
  }
  try {
    if (_ws !== sock) {
      _ws = sock
      _active = true
    }
    _lastSentPhase = 'listening'
    sock.send(JSON.stringify({ type: 'client_phase', phase: 'listening' }))
    sock.send(JSON.stringify({ type: 'client_listening' }))
    voiceFeLog('管线', `forceOpenMic 已发送 phase+listening reason=${reason}`)
    return true
  } catch (e) {
    voiceFeLog('决策', `forceOpenMic send 失败：${e?.message || e}`)
    return false
  }
}

/**
 * 同步 FE 相位给后端，用于抑制思考期 VAD barge / 暂缓 unmute。
 * @param {string} phase
 * @param {{ force?: boolean }} [opts]
 */
export function sendXiaomiClientPhase(phase, opts = {}) {
  if (!isXiaomiFrameSessionActive()) return
  const p = String(phase || '').trim().toLowerCase() || 'idle'
  if (!opts.force && p === _lastSentPhase) return
  _lastSentPhase = p
  try {
    _ws.send(JSON.stringify({ type: 'client_phase', phase: p }))
    voiceFeLog('决策', `同步后端 client_phase=${p}${opts.force ? ' force=1' : ''}`)
  } catch (e) {
    voiceFeLog('决策', `同步 client_phase 失败：${e?.message || e}`)
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
  _finishedSeqs.clear()
  for (const seq of [..._play.keys()]) {
    _disposeEntry(seq)
  }
  _replyPlayLogged = false
  // 不在这里发 client_listening：assistant_begin 清旧队列时发会思考期误 unmute。
  // interrupted / 真停播由调用方显式 send。
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

/**
 * @param {{ preservePlayback?: boolean }} [opts]
 *   preservePlayback=true：工具轮次间「新一段正文」开闸，勿拆掉上一段还在播的队列
 */
export function sendXiaomiAssistantBegin(opts = {}) {
  if (!isXiaomiFrameSessionActive()) return false
  try {
    let tid = getVoiceTrace()
    if (!tid) tid = beginVoiceTrace({ reason: 'assistant_begin' })
    _dropIncomingAudio = false
    const preserve = !!opts.preservePlayback
    // 新用户轮开闸：清掉卡死的旧队列。同轮多段正文（工具后下一段）要保留上一段播报。
    if (!preserve && (_playingSeq != null || _playOrder.length > 0 || _play.size > 0)) {
      voiceFeLog('播报', 'assistant_begin → 清空上一轮未播完队列')
      _teardownAllAudio()
    } else if (!preserve) {
      _finishedSeqs.clear()
      resetXiaomiReplyPlayMark()
    }
    _ws.send(JSON.stringify({ type: 'assistant_begin', trace_id: tid }))
    voicePlaybackMark(
      '流式正文',
      '',
      `assistant_begin → Frame TRACE=${tid}${preserve ? '（保留在播）' : ''}`,
    )
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
  // 本地主动停播（非 barge_in）也要放麦，否则 STT 一直 hold
  _maybeNotifyListening()
}

/**
 * @param {{ reason?: string }} [opts]
 */
export function bargeInXiaomiFrame(opts = {}) {
  if (!isXiaomiFrameSessionActive()) return
  const reason = String(opts.reason || 'client_barge_in')
  // 本地没在播：空闲 stopAll 再 barge 只会抬 min_turn、刷 interrupted，无益
  if (
    !isXiaomiFramePlaying() &&
    (reason === 'stopAllAssistantSpeech' || reason === 'wake-word-hit')
  ) {
    return
  }
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
  _lastSentPhase = ''
  if (_phaseUnsub) {
    try {
      _phaseUnsub()
    } catch {
      /* ignore */
    }
    _phaseUnsub = null
  }
}

export function isXiaomiFrameRuntimePreferred() {
  return _active && isXiaomiFrameSessionActive()
}
