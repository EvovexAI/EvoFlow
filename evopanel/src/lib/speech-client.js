/**
 * Gateway speech API client (Volcengine ASR/TTS for chat).
 *
 * 追踪日志（`[speech-queue] …` / `[speech-client] 已停止…`）默认静默 —— 它们是
 * 每句 TTS、每个流式 chunk、每次 barge-in 都打一行，正常使用时会持续刷屏。
 * 排查 TTS 播放 / 打断队列时打开：
 *   localStorage.setItem('EVOFLOW_DEBUG_SPEECH', '1')
 * `console.warn` 的异常（播放失败、连续失败、transcript 重对齐）不受此开关影响。
 */

import { apiUrl } from './api-client.js'
import { isDebugOn } from './debug-flag.js'

/** TTS/ASR 追踪日志是否放行。默认 false。 */
function _ttsLog(...args) {
  if (!isDebugOn('EVOFLOW_DEBUG_SPEECH')) return
  console.log(...args)
}

/** @type {boolean | null} */
let _configuredCache = null
/** @type {boolean | null} */
let _streamingAsrCache = null

export async function fetchSpeechConfigured() {
  const url = import.meta.env?.DEV ? '/api/speech/status' : apiUrl('/speech/status')
  const res = await fetch(url, { credentials: 'same-origin' })
  if (!res.ok) {
    _configuredCache = false
    _streamingAsrCache = false
    return false
  }
  const data = await res.json().catch(() => ({}))
  _configuredCache = !!data?.configured
  const { isVolcengineAsrEnabled } = await import('./voice-asr-policy.js')
  _streamingAsrCache = isVolcengineAsrEnabled() && !!data?.streaming_asr
  return _configuredCache
}

export function speechConfiguredCached() {
  return _configuredCache
}

export function speechStreamingAsrCached() {
  return _streamingAsrCache
}

/** @param {unknown} detail */
function _ttsErrorDetail(detail, status) {
  if (typeof detail === 'string' && detail.trim()) return detail
  if (detail && typeof detail === 'object' && typeof detail.msg === 'string') return detail.msg
  return `TTS failed: ${status}`
}

/** @param {Response} res */
async function _readTtsAudioBlob(res) {
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(_ttsErrorDetail(err.detail, res.status))
  }
  const blob = await res.blob()
  if (!blob || blob.size < 32) {
    throw new Error('TTS returned empty audio')
  }
  return blob
}

function resolveSpeechGatewayHttpBase() {
  const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
  if (!isTauri) {
    try {
      if (import.meta?.env?.DEV) return ''
    } catch {
      // ignore
    }
  }
  try {
    const env = (import.meta && import.meta.env) || {}
    const url = String(env.VITE_EVOFLOW_GATEWAY_URL || env.EVOFLOW_GATEWAY_URL || '').trim()
    if (url) return url.replace(/\/+$/, '')
    const port = parseInt(String(env.VITE_EVOFLOW_GATEWAY_PORT || env.EVOFLOW_GATEWAY_PORT || '').trim(), 10)
    if (Number.isFinite(port) && port > 0 && port < 65536) return `http://127.0.0.1:${port}`
  } catch {
    // ignore
  }
  return ''
}

/**
 * @returns {Promise<string>}
 */
export async function speechAsrStreamUrl() {
  let httpUrl = ''
  try {
    if (import.meta?.DEV) {
      let direct = resolveSpeechGatewayHttpBase()
      if (!direct) {
        try {
          const res = await fetch('/__api/workspace_runtime_info', { credentials: 'same-origin' })
          if (res.ok) {
            const data = await res.json().catch(() => ({}))
            direct = String(data?.runtimeBaseUrl || '').trim().replace(/\/+$/, '')
          }
        } catch {
          // ignore
        }
      }
      if (direct) httpUrl = `${direct}/api/speech/asr/stream`
    }
  } catch {
    // ignore
  }
  if (!httpUrl) {
    const { apiUrlAsync } = await import('./api-client.js')
    httpUrl = import.meta.env?.DEV ? '/api/speech/asr/stream' : await apiUrlAsync('/speech/asr/stream')
  }
  if (httpUrl.startsWith('ws://') || httpUrl.startsWith('wss://')) return httpUrl
  const base =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://127.0.0.1'
  const u = new URL(httpUrl, base)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  return u.toString()
}

/**
 * @param {Blob} wavBlob
 * @returns {Promise<string>}
 */
export async function transcribeSpeechAudio(wavBlob) {
  const { isVolcengineAsrEnabled } = await import('./voice-asr-policy.js')
  if (!isVolcengineAsrEnabled()) {
    throw new Error('火山语音识别已临时关闭，请使用系统语音输入')
  }
  const url = import.meta.env?.DEV ? '/api/speech/asr' : apiUrl('/speech/asr')
  const form = new FormData()
  form.append('audio', wavBlob, 'voice.wav')
  const res = await fetch(url, { method: 'POST', credentials: 'same-origin', body: form })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || `ASR failed: ${res.status}`)
  }
  const data = await res.json()
  return String(data?.text || '').trim()
}

/** @type {HTMLAudioElement | null} */
let _activeAudio = null
/** 每次 play / stop 递增；用于区分「被打断」与真正的 NotSupportedError */
let _playGeneration = 0
let _playbackUnlocked = false

// ─── TTS 播报状态广播 ───
let _speaking = false
/** @type {Set<(speaking: boolean) => void>} */
const _speakingListeners = new Set()

function _setSpeaking(v) {
  if (_speaking === v) return
  _speaking = v
  for (const cb of _speakingListeners) {
    try { cb(v) } catch { /* ignore */ }
  }
}

/**
 * 订阅 TTS 播报状态变化（播报开始/结束）。
 * @param {(speaking: boolean) => void} cb
 * @returns {() => void} 取消订阅
 */
export function onSpeakingChange(cb) {
  _speakingListeners.add(cb)
  return () => _speakingListeners.delete(cb)
}

/** 当前是否正在播报 */
export function isAssistantSpeaking() {
  return _speaking
}

/**
 * 从 pos 起切下一段可播报文本；无完整句时积累够长也会在停顿符/硬切点断开。
 * @param {string} clean
 * @param {number} pos
 * @param {{ first?: boolean }} [opts] first=true 时首句用更短的最小长度（快速开口）
 */
export function advanceSpeechChunk(clean, pos, opts = {}) {
  if (!clean || pos >= clean.length) return pos
  for (let i = pos; i < clean.length; i++) {
    const ch = clean[i]
    if (ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?' || ch === '\n') {
      return i + 1
    }
  }
  // 首句快速开口：回答开头常是「好的，我看一下…」，第一个停顿符（≥2 字）就切，
  // 让 TTS 提前 300-800ms 起播；20 字仍无停顿则硬切开口；后续句保持长阈值避免碎句感。
  if (opts.first) {
    const limit = Math.min(clean.length, pos + 20)
    for (let i = pos + 2; i < limit; i++) {
      const ch = clean[i]
      if (ch === '，' || ch === ',' || ch === '；' || ch === ';' || ch === '、') {
        return i + 1
      }
    }
    return clean.length - pos >= 20 ? pos + 20 : pos
  }
  const MIN_PHRASE = 48
  if (clean.length - pos < MIN_PHRASE) return pos
  for (let i = Math.min(clean.length - 1, pos + MIN_PHRASE); i >= pos + 20; i--) {
    const ch = clean[i]
    if (ch === '，' || ch === ',' || ch === '；' || ch === ';' || ch === '、' || ch === ' ') {
      return i + 1
    }
  }
  return Math.min(pos + MIN_PHRASE, clean.length)
}

/** 流式队列当前音色（空=服务端默认） */
let _queueSpeaker = ''

/**
 * 设置流式播报音色（会议室按员工切换；空字符串回到默认）。
 * @param {string} [speaker]
 */
export function setStreamingSpeechSpeaker(speaker) {
  _queueSpeaker = String(speaker || '').trim()
  void import('./speech-session-client.js')
    .then(({ setSpeechSessionSpeaker }) => setSpeechSessionSpeaker(_queueSpeaker))
    .catch(() => {})
}

export function getStreamingSpeechSpeaker() {
  return _queueSpeaker
}

/**
 * @param {string} text
 * @param {{ speaker?: string }} [opts]
 * @returns {Promise<{ objectUrl: string, audio: HTMLAudioElement } | null>}
 */
/** Frame / 语音全屏时禁止 legacy 再开 `/api/speech/session`（会双管线乱播）。 */
async function _speechSessionTtsAllowed() {
  if (localStorage.getItem('evoflow-voice-session') === '0') return false
  try {
    const { isXiaomiFrameSessionActive, isXiaomiFrameSessionConnecting } = await import(
      './xiaomi-voice/session-client.js',
    )
    if (isXiaomiFrameSessionActive()) return false
    if (isXiaomiFrameSessionConnecting?.()) return false
  } catch {
    /* ignore */
  }
  try {
    const { isXwVoiceMode } = await import('./xw-voice-mode.js')
    if (isXwVoiceMode()) return false
  } catch {
    /* ignore */
  }
  return true
}

/**
 * 合成一句并返回 Blob（固定短句音效缓存用）。
 * **强制 HTTP**：绝不能走 speech-session，否则会另开一条 Frame 管线，
 * 日志里出现「直接播报句「在呢」」并被 barge_in 风暴打断正文。
 * @param {string} text
 * @param {{ speaker?: string }} [opts]
 * @returns {Promise<Blob | null>}
 */
export async function fetchSpeechAudioBlob(text, opts = {}) {
  const pack = await _fetchSentenceAudio(text, { ...opts, httpOnly: true })
  if (!pack?.objectUrl) return null
  try {
    const res = await fetch(pack.objectUrl)
    if (!res.ok) return null
    const blob = await res.blob()
    return blob && blob.size > 0 ? blob : null
  } catch {
    return null
  } finally {
    try {
      pack.audio?.pause?.()
    } catch {
      /* ignore */
    }
    try {
      URL.revokeObjectURL(pack.objectUrl)
    } catch {
      /* ignore */
    }
  }
}

/** 同文同音色在途合成去重，避免队列重试 / 并发踢播放把同一句打爆后端 */
/** @type {Map<string, Promise<{ objectUrl: string, audio: HTMLAudioElement, text?: string } | null>>} */
const _ttsInflight = new Map()

/**
 * @param {string} text
 * @param {{ speaker?: string, httpOnly?: boolean }} [opts]
 */
async function _fetchSentenceAudio(text, opts = {}) {
  const plain = plainTextForSpeech(text)
  if (!plain) return null
  const speaker = String(opts.speaker || _queueSpeaker || '').trim()
  const inflightKey = `${opts.httpOnly ? 'h' : 's'}::${speaker}::${plain}`
  const hit = _ttsInflight.get(inflightKey)
  if (hit) return hit

  const task = _fetchSentenceAudioUniq(plain, speaker, opts).finally(() => {
    if (_ttsInflight.get(inflightKey) === task) _ttsInflight.delete(inflightKey)
  })
  _ttsInflight.set(inflightKey, task)
  return task
}

/**
 * @param {string} plain
 * @param {string} speaker
 * @param {{ speaker?: string, httpOnly?: boolean }} [opts]
 */
async function _fetchSentenceAudioUniq(plain, speaker, opts = {}) {
  // P1 会话 WS 流式通道：未连接/超时/MSE 不可用 → 逐句自动回退 HTTP
  // Frame / 语音全屏 / httpOnly：禁止再开第二条 session
  if (!opts.httpOnly && (await _speechSessionTtsAllowed())) {
    try {
      const { fetchSpeechSessionAudio } = await import('./speech-session-client.js')
      const pack = await fetchSpeechSessionAudio(plain, { speaker })
      if (pack) {
        // 会话 WS 路径不回传 X-Tts-Speaker；音色与 HTTP 相同规则（空=Gateway 媒体默认）
        let label = speaker || '(Gateway 默认音色)'
        try {
          const { resolveTtsSpeakerLabel } = await import('./xiaomi-voice-defaults.js')
          label = await resolveTtsSpeakerLabel(speaker)
        } catch {
          /* ignore */
        }
        console.info(
          '[xiaomi-voice] TTS ok (session WS)',
          `音色=${label}`,
          speaker ? `id=${speaker}` : 'reqSpeaker=(empty→Gateway默认)',
          '（前台开始播放）',
        )
        void import('./xiaomi-voice/voice-file-log.js')
          .then(({ voicePlaybackMark }) =>
            voicePlaybackMark(
              '语音合成',
              plain,
              `session WS 完成 音色=${label}`,
            ),
          )
          .catch(() => {})
        return { ...pack, text: plain }
      }
    } catch {
      /* fallthrough → HTTP */
    }
  }
  // Non-stream /tts returns a complete mp3; HTMLAudioElement handles it more reliably
  // than a blob assembled from /tts/stream (truncated streams can hang without onended).
  const url = import.meta.env?.DEV ? '/api/speech/tts' : apiUrl('/speech/tts')
  // 里程碑：前台 → Gateway TTS（后台火山合成）
  // speaker 空 = 请求体不带 speaker，Gateway 用媒体设置 / 环境默认音色
  console.info(
    '[xiaomi-voice] TTS fetch →',
    url,
    JSON.stringify(plain.slice(0, 40)),
    speaker ? `reqSpeaker=${speaker}` : 'reqSpeaker=(empty→Gateway默认)',
  )
  const synthStartedAt = Date.now()
  void import('./xiaomi-voice/voice-file-log.js')
    .then(({ voicePlaybackMark }) =>
      voicePlaybackMark(
        '语音合成',
        plain,
        `HTTP 请求开始 ${url}${speaker ? ` speaker=${speaker}` : ''}`,
      ),
    )
    .catch(() => {})
  _ttsLog(
    '[speech-queue] tts fetch',
    JSON.stringify(plain.slice(0, 40)),
    speaker ? `speaker=${speaker}` : 'speaker=default',
  )
  /** @type {Record<string, string>} */
  const body = { text: plain }
  if (speaker) body.speaker = speaker
  try {
    const { getVoiceTrace } = await import('./xiaomi-voice/voice-file-log.js')
    const tid = getVoiceTrace()
    if (tid) body.trace_id = tid
  } catch {
    /* ignore */
  }
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    console.warn('[xiaomi-voice] TTS HTTP failed', res.status, url, '（检查 Gateway 火山 TTS 配置）')
    void import('./xiaomi-voice/voice-file-log.js')
      .then(({ voicePlaybackMark }) =>
        voicePlaybackMark('语音合成', plain, `HTTP 失败 status=${res.status}`),
      )
      .catch(() => {})
  }
  const usedSpeaker = String(res.headers.get('X-Tts-Speaker') || speaker || '').trim()
  let speakerLabel = usedSpeaker || '(未知)'
  try {
    const { resolveTtsSpeakerLabel } = await import('./xiaomi-voice-defaults.js')
    speakerLabel = await resolveTtsSpeakerLabel(usedSpeaker)
  } catch {
    /* ignore */
  }
  const blob = await _readTtsAudioBlob(res)
  const synthMs = Date.now() - synthStartedAt
  console.info(
    '[xiaomi-voice] TTS ok',
    `bytes=${blob.size}`,
    `音色=${speakerLabel}`,
    usedSpeaker ? `id=${usedSpeaker}` : '',
    `cost=${synthMs}ms`,
    '（前台开始播放）',
  )
  void import('./xiaomi-voice/voice-file-log.js')
    .then(({ voicePlaybackMark }) =>
      voicePlaybackMark(
        '语音合成',
        plain,
        `HTTP 完成 bytes=${blob.size} 音色=${speakerLabel} cost=${synthMs}ms`,
      ),
    )
    .catch(() => {})
  _ttsLog('[speech-queue] tts ok bytes=', blob.size, 'speaker=', usedSpeaker || '(default)')
  const objectUrl = URL.createObjectURL(blob)
  const audio = new Audio(objectUrl)
  return { objectUrl, audio, text: plain }
}

/**
 * @param {{ objectUrl: string, audio: HTMLAudioElement, text?: string }} prepared
 * @param {{ timeoutMs?: number }} [opts]
 */
async function _playPreparedAudio(prepared, opts = {}) {
  const objectUrl = prepared?.objectUrl
  if (!objectUrl) throw new Error('TTS audio missing objectUrl')
  // 每次播放新建 Audio：预取的 element 可能被 stopAssistantSpeech 糟蹋过
  const audio = new Audio(objectUrl)
  const playText = String(prepared?.text || '').trim()
  const timeoutMs = Math.max(8000, Number(opts.timeoutMs) || 90000)
  const playGen = ++_playGeneration
  _activeAudio = audio
  audio.volume = 1
  _setSpeaking(true)
  const playStartedAt = Date.now()
  let playLogged = false
  let interrupted = false

  try {
    try {
      const { routeAudioOutput } = await import('./audio-output.js')
      await routeAudioOutput(audio)
    } catch {
      /* system default sink */
    }

    await new Promise((resolve, reject) => {
      let settled = false
      /** @type {ReturnType<typeof setTimeout> | null} */
      let hangTimer = null
      const done = (err) => {
        if (settled) return
        settled = true
        if (hangTimer) clearTimeout(hangTimer)
        audio.onended = null
        audio.onerror = null
        audio.onloadedmetadata = null
        if (err) reject(err)
        else resolve(undefined)
      }

      const armHangTimer = (ms, asError) => {
        if (hangTimer) clearTimeout(hangTimer)
        hangTimer = setTimeout(() => {
          try {
            audio.pause()
          } catch {
            /* ignore */
          }
          if (asError) done(new Error(`TTS playback timeout (${ms}ms)`))
          else {
            _ttsLog('[speech-queue] play ended via duration fallback')
            done()
          }
        }, ms)
      }
      armHangTimer(timeoutMs, true)

      audio.onended = () => {
        _ttsLog('[speech-queue] play ended')
        done()
      }
      audio.onerror = () => {
        if (playGen !== _playGeneration) {
          interrupted = true
          done(new Error('TTS interrupted'))
          return
        }
        done(new Error('Audio playback failed'))
      }
      audio.onloadedmetadata = () => {
        const dur = Number(audio.duration)
        _ttsLog('[speech-queue] play metadata duration=', dur)
        if (!Number.isFinite(dur) || dur <= 0) {
          done(new Error('TTS audio duration is 0'))
          return
        }
        // onended 偶发不触发：按时长正常结束，避免 playing=true 堵死整条队列
        armHangTimer(Math.ceil(dur * 1000) + 1500, false)
      }

      _ttsLog('[speech-queue] play start')
      void import('./xiaomi-voice/voice-file-log.js')
        .then(({ voicePlaybackMark }) => {
          if (playLogged) return
          playLogged = true
          voicePlaybackMark('语音播放', playText, `HTMLAudio.play 开始 t=${new Date().toISOString()}`)
        })
        .catch(() => {})
      audio.play().catch((e) => {
        if (playGen !== _playGeneration) {
          interrupted = true
          done(new Error('TTS interrupted'))
          return
        }
        done(e)
      })
    })
    void import('./xiaomi-voice/voice-file-log.js')
      .then(({ voicePlaybackMark }) =>
        voicePlaybackMark(
          '播放结束',
          playText,
          `正常结束 duration=${Date.now() - playStartedAt}ms`,
        ),
      )
      .catch(() => {})
  } catch (e) {
    const name = e?.name || ''
    const msg = e?.message || String(e)
    if (interrupted || /interrupted/i.test(msg) || name === 'AbortError') {
      void import('./xiaomi-voice/voice-file-log.js')
        .then(({ voicePlaybackMark }) =>
          voicePlaybackMark('播放结束', playText, `被打断 duration=${Date.now() - playStartedAt}ms`),
        )
        .catch(() => {})
      const err = new Error('TTS interrupted')
      err.name = 'TTSInterrupted'
      throw err
    }
    void import('./xiaomi-voice/voice-file-log.js')
      .then(({ voicePlaybackMark }) =>
        voicePlaybackMark('播放结束', playText, `失败 ${name} ${msg}`),
      )
      .catch(() => {})
    throw e
  } finally {
    try {
      audio.pause()
    } catch {
      /* ignore */
    }
    // 仅在本轮仍持有该 url 时释放；打断后队列可能还要用同一 blob 重试 → 由调用方决定 revoke
    if (!opts.keepObjectUrl) {
      try {
        URL.revokeObjectURL(objectUrl)
      } catch {
        /* ignore */
      }
    }
    if (_activeAudio === audio) _activeAudio = null
    _setSpeaking(false)
  }
}

/** @param {string} a @param {string} b */
function _commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

/** @type {(() => void) | null} */
let _onSpeechQueueIdle = null
/** @type {Set<() => void>} */
const _speechIdleWaiters = new Set()

/** 流式播报队列排空时回调（用于持续监听 barge-in 解除挂起） */
export function setSpeechQueueIdleCallback(cb) {
  _onSpeechQueueIdle = typeof cb === 'function' ? cb : null
}

function _notifySpeechQueueIdle() {
  try {
    _onSpeechQueueIdle?.()
  } catch {
    /* ignore */
  }
  if (_speechIdleWaiters.size) {
    const waiters = [..._speechIdleWaiters]
    _speechIdleWaiters.clear()
    for (const w of waiters) {
      try {
        w()
      } catch {
        /* ignore */
      }
    }
  }
}

/** @type {(() => boolean) | null} */
let _speechBusyExtra = null

/** 额外忙碌源（如 Frame MSE 串行播报）；由 background-voice / xiaomi-voice 注册 */
export function registerSpeechBusyExtra(fn) {
  _speechBusyExtra = typeof fn === 'function' ? fn : null
}

/** Whether assistant TTS (single-shot, streaming queue, or Frame local play) is active / pending. */
export function isSpeechPlaybackBusy() {
  if (_speaking || _speechQueue.playing) return true
  if (_speechQueue.sentences.some((s) => !s.played)) return true
  try {
    if (_speechBusyExtra?.()) return true
  } catch {
    /* ignore */
  }
  return false
}

/**
 * Resolve when TTS finishes (or already idle). Does not steal setSpeechQueueIdleCallback.
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<void>}
 */
export function waitForSpeechPlaybackIdle(opts = {}) {
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 120000)
  if (!isSpeechPlaybackBusy()) return Promise.resolve()

  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(hardTimer)
      unsub()
      _speechIdleWaiters.delete(onIdle)
      resolve()
    }
    const onIdle = () => {
      // Brief defer: speaking flag may clear between queue sentences.
      queueMicrotask(() => {
        if (!isSpeechPlaybackBusy()) finish()
      })
    }
    const unsub = onSpeakingChange((speaking) => {
      if (!speaking) onIdle()
    })
    _speechIdleWaiters.add(onIdle)
    const hardTimer = setTimeout(finish, timeoutMs)
  })
}

/** 流式语音播放队列：预取 TTS + 合并短句，减少句间空档 */
const _speechQueue = {
  /** @type {Array<{ id: string, text: string, played: boolean, prefetch?: Promise<{ objectUrl: string, audio: HTMLAudioElement } | null> | null, objectUrl?: string | null }>} */
  sentences: [],
  playing: false,
  lastPlayedIndex: -1,
  lastProcessedLength: 0,
  /** @type {string} */
  lastCleanSnapshot: '',
  consecutiveFailures: 0,
  maxConsecutiveFailures: 3,
  prefetchAhead: 2,
  /** When true, append/prefetch may run but playback waits (ack race). */
  holdPlayback: false,
  /** 防止 append/finalFlush 并发踢播放导致同句双合成双播 */
  _playChain: /** @type {Promise<void> | null} */ (null),

  reset() {
    for (const s of this.sentences) {
      if (s.objectUrl) {
        URL.revokeObjectURL(s.objectUrl)
        s.objectUrl = null
      }
      s.prefetch = null
    }
    this.sentences = []
    this.lastPlayedIndex = -1
    this.lastProcessedLength = 0
    this.lastCleanSnapshot = ''
    this.consecutiveFailures = 0
    this.playing = false
    this.holdPlayback = false
    this._playChain = null
    _setSpeaking(false)
  },

  /** 流式正文被改写时，按最长安全公共前缀回退 processed 游标，避免重复播报。 */
  _realignProcessedLength(/** @type {string} */ clean) {
    if (!clean) return
    if (!this.lastCleanSnapshot) {
      this.lastCleanSnapshot = clean
      return
    }
    const processedPrefix = this.lastCleanSnapshot.slice(0, this.lastProcessedLength)
    if (clean.startsWith(processedPrefix)) {
      this.lastCleanSnapshot = clean
      return
    }
    const aligned = _commonPrefixLen(this.lastCleanSnapshot, clean)
    if (aligned < this.lastProcessedLength) {
      console.warn(
        '[speech-queue] transcript rewrite, realign',
        this.lastProcessedLength,
        '->',
        aligned,
      )
      this.lastProcessedLength = aligned
    }
    this.lastCleanSnapshot = clean
  },

  /** @param {string} remaining */
  _isDuplicateTail(remaining) {
    if (!remaining) return true
    const last = this.sentences[this.sentences.length - 1]
    if (last?.text === remaining) return true
    const processed = this.lastCleanSnapshot.slice(0, this.lastProcessedLength)
    return processed.endsWith(remaining)
  },

  /** @param {string} text */
  peekRemaining(text) {
    const clean = plainTextForSpeech(text)
    if (!clean) return ''
    this._realignProcessedLength(clean)
    return clean.slice(this.lastProcessedLength).trim()
  },

  /** @param {{ id: string, text: string, played: boolean }} item */
  _enqueueChunk(item) {
    let t = String(item.text || '').trim()
    if (!t) return
    // 去重 / 去重叠：流式先切「三件事…进度、」再入长句时，禁止把已播前缀再说一遍
    for (const s of this.sentences) {
      const st = String(s.text || '').trim()
      if (!st) continue
      if (st === t) return
      if (st.startsWith(t) && st.length > t.length) return
      if (t.startsWith(st)) {
        if (!s.played && !s.prefetch) {
          s.text = t
          return
        }
        const rest = t.slice(st.length).trim()
        if (!rest) return
        t = rest
      }
    }
    if (!t || this.sentences.some((s) => s.text === t)) return
    const tail = this.sentences[this.sentences.length - 1]
    if (
      tail &&
      !tail.played &&
      !tail.prefetch &&
      tail.text.length + t.length <= 96
    ) {
      const merged = `${tail.text}${t}`
      if (this.sentences.some((s) => s !== tail && s.text === merged)) return
      tail.text = merged
      return
    }
    this.sentences.push({ ...item, text: t })
  },

  /** @param {number} fromIdx */
  _schedulePrefetch(fromIdx) {
    const end = Math.min(this.sentences.length, fromIdx + 1 + this.prefetchAhead)
    for (let i = fromIdx; i < end; i++) {
      const s = this.sentences[i]
      if (!s || s.played || s.prefetch) continue
      s.prefetch = _fetchSentenceAudio(s.text)
        .then((pack) => {
          if (pack) s.objectUrl = pack.objectUrl
          return pack
        })
        .catch((e) => {
          s.prefetch = null
          throw e
        })
    }
  },

  /** @param {{ prefetch?: Promise<{ objectUrl: string, audio: HTMLAudioElement } | null> | null, text: string }} sentence */
  async _ensurePrepared(sentence) {
    if (!sentence.prefetch) {
      sentence.prefetch = _fetchSentenceAudio(sentence.text).then((pack) => {
        if (pack) sentence.objectUrl = pack.objectUrl
        return pack
      })
    }
    const prepared = await sentence.prefetch
    sentence.prefetch = null
    if (!prepared) throw new Error('TTS empty')
    return prepared
  },

  append(/** @type {string} */ text) {
    const clean = plainTextForSpeech(text)
    if (!clean) return false
    this._realignProcessedLength(clean)
    if (clean.length <= this.lastProcessedLength) return false

    let pos = this.lastProcessedLength
    while (pos < clean.length) {
      const end = advanceSpeechChunk(clean, pos, {
        first: this.sentences.length === 0 && this.lastPlayedIndex < 0,
      })
      if (end <= pos) break

      const chunk = clean.slice(pos, end).trim()
      if (chunk.length >= 2) {
        _ttsLog('[speech-queue] append chunk:', JSON.stringify(chunk), 'pos:', pos, '->', end)
        this._enqueueChunk({
          id: `s-${this.sentences.length}`,
          text: chunk,
          played: false,
        })
      }
      pos = end
      while (pos < clean.length && /\s/.test(clean[pos])) pos++
    }

    this.lastProcessedLength = pos
    const nextIdx = this.sentences.findIndex((s) => !s.played)
    if (nextIdx >= 0) this._schedulePrefetch(nextIdx)
    this._tryPlayNext()
    return true
  },

  finalFlush(/** @type {string} */ text) {
    const clean = plainTextForSpeech(text)
    // Final 必须再给播放机会：流式阶段 TTS 失败不应永久掐死收尾播报
    this.consecutiveFailures = 0
    if (!clean) {
      this._kickPlay()
      return this.sentences.some((s) => !s.played)
    }
    this._realignProcessedLength(clean)
    const remaining = clean.slice(this.lastProcessedLength).trim()
    _ttsLog(
      '[speech-queue] finalFlush: lastProcessedLength=',
      this.lastProcessedLength,
      'clean.length=',
      clean.length,
      'remaining=',
      JSON.stringify(remaining),
    )
    let enqueued = false
    if (remaining && remaining.length > 2 && !this._isDuplicateTail(remaining)) {
      this._enqueueChunk({
        id: `s-${this.sentences.length}`,
        text: remaining,
        played: false,
      })
      this.lastProcessedLength = clean.length
      this.lastCleanSnapshot = clean
      enqueued = true
    } else if (remaining && remaining.length > 2 && this._isDuplicateTail(remaining)) {
      _ttsLog('[speech-queue] finalFlush: skip duplicate remaining, kick unplayed')
      this.lastProcessedLength = clean.length
      this.lastCleanSnapshot = clean
    } else {
      this.lastProcessedLength = Math.max(this.lastProcessedLength, clean.length)
      this.lastCleanSnapshot = clean
    }
    const nextIdx = this.sentences.findIndex((s) => !s.played)
    if (nextIdx >= 0) this._schedulePrefetch(nextIdx)
    this._kickPlay()
    return enqueued || nextIdx >= 0
  },

  _kickPlay() {
    void this._tryPlayNext()
  },

  /**
   * 串行排空播放队列。append/finalFlush 可并发调用，但实际播放只走一条 chain，
   * 否则同句会 _ensurePrepared 两次（prefetch 被置空后再拉）→ 双合成双播。
   */
  async _tryPlayNext() {
    if (this._playChain) {
      await this._playChain
      // chain 结束时可能又入队了新句，再踢一轮
      if (!this.holdPlayback && this.sentences.some((s) => !s.played)) {
        return this._tryPlayNext()
      }
      return
    }
    this._playChain = this._drainPlayQueue()
    try {
      await this._playChain
    } finally {
      this._playChain = null
    }
  },

  async _drainPlayQueue() {
    if (this.holdPlayback) return
    this.playing = true
    try {
      while (!this.holdPlayback) {
        if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
          console.warn(
            '[speech-queue] 连续播放失败超过',
            this.maxConsecutiveFailures,
            '次，停止自动播放',
          )
          break
        }
        const nextIdx = this.sentences.findIndex((s) => !s.played)
        if (nextIdx < 0 || nextIdx <= this.lastPlayedIndex) break

        const sentence = this.sentences[nextIdx]
        if (sentence.text.trim().length < 2) {
          sentence.played = true
          this.lastPlayedIndex = nextIdx
          continue
        }

        this._schedulePrefetch(nextIdx + 1)

        try {
          // 清掉确认语等残留 Audio，避免占着 _activeAudio
          stopAssistantSpeech()
          let prepared = await this._ensurePrepared(sentence)
          try {
            await _playPreparedAudio({
              ...prepared,
              text: prepared?.text || sentence.text || '',
            })
          } catch (playErr) {
            const msg = String(playErr?.message || playErr || '')
            const interrupted =
              playErr?.name === 'TTSInterrupted' || /interrupted/i.test(msg)
            // continuous 回声打断：不要立刻重拉同句（否则 400ms 一刀 → TTS 风暴）
            if (interrupted) {
              sentence.prefetch = null
              void import('./xiaomi-voice/voice-file-log.js')
                .then(({ voicePlaybackMark }) =>
                  voicePlaybackMark(
                    '播放结束',
                    sentence.text || '',
                    '被打断，保留队列等待后续 kick',
                  ),
                )
                .catch(() => {})
              break
            }
            // NotSupportedError（旧 src='' 残毒 / blob 失效）：换新鲜 Audio 再试一次
            if (
              playErr?.name === 'NotSupportedError' ||
              /no supported sources/i.test(msg)
            ) {
              if (prepared?.objectUrl) {
                try {
                  URL.revokeObjectURL(prepared.objectUrl)
                } catch {
                  /* ignore */
                }
              }
              sentence.objectUrl = null
              sentence.prefetch = null
              prepared = await _fetchSentenceAudio(sentence.text)
              if (!prepared) throw playErr
              await _playPreparedAudio({
                ...prepared,
                text: prepared?.text || sentence.text || '',
              })
            } else {
              throw playErr
            }
          }
          sentence.played = true
          this.lastPlayedIndex = nextIdx
          sentence.objectUrl = null
          this.consecutiveFailures = 0
        } catch (e) {
          console.warn('[speech-queue] play failed', e)
          void import('./xiaomi-voice/voice-file-log.js')
            .then(({ voicePlaybackMark }) =>
              voicePlaybackMark(
                '播放结束',
                sentence.text || '',
                `play failed ${e?.name || ''} ${e?.message || String(e)}`,
              ),
            )
            .catch(() => {})
          // 失败也前进，避免同一句死循环打 TTS；留给后续句
          sentence.played = true
          this.lastPlayedIndex = nextIdx
          this.consecutiveFailures++
        }
      }
    } finally {
      this.playing = false
      const more = this.sentences.findIndex((s) => !s.played)
      if (more < 0 || this.consecutiveFailures >= this.maxConsecutiveFailures) {
        _notifySpeechQueueIdle()
      }
    }
  },
}

/** 单次播报预取缓存（会议室下一位可先合成） */
/** @type {Map<string, Promise<{ objectUrl: string, audio: HTMLAudioElement } | null>>} */
const _oneshotPrefetch = new Map()

function _oneshotCacheKey(text, speaker) {
  return `${String(speaker || '').trim()}::${plainTextForSpeech(text)}`
}

/**
 * 预取 TTS 音频（不播放）。会议室可在上一位播报时生成下一位。
 * @param {string} text
 * @param {{ speaker?: string }} [opts]
 * @returns {Promise<{ objectUrl: string, audio: HTMLAudioElement } | null>}
 */
export function prefetchAssistantSpeech(text, opts = {}) {
  const plain = plainTextForSpeech(text)
  if (!plain) return Promise.resolve(null)
  const key = _oneshotCacheKey(plain, opts.speaker)
  const hit = _oneshotPrefetch.get(key)
  if (hit) return hit
  const p = _fetchSentenceAudio(plain, opts).catch((e) => {
    _oneshotPrefetch.delete(key)
    console.warn('[speech-client] prefetch failed', e)
    return null
  })
  _oneshotPrefetch.set(key, p)
  // 防止缓存无限涨
  if (_oneshotPrefetch.size > 12) {
    const first = _oneshotPrefetch.keys().next().value
    if (first && first !== key) {
      const old = _oneshotPrefetch.get(first)
      _oneshotPrefetch.delete(first)
      void Promise.resolve(old).then((pack) => {
        if (pack?.objectUrl) {
          try {
            URL.revokeObjectURL(pack.objectUrl)
          } catch {
            /* ignore */
          }
        }
      })
    }
  }
  return p
}

export function clearAssistantSpeechPrefetch() {
  for (const p of _oneshotPrefetch.values()) {
    void Promise.resolve(p).then((pack) => {
      if (pack?.objectUrl) {
        try {
          URL.revokeObjectURL(pack.objectUrl)
        } catch {
          /* ignore */
        }
      }
    })
  }
  _oneshotPrefetch.clear()
}

/**
 * @param {string} text
 * @param {{ speaker?: string }} [opts]
 */
async function _playSentenceInternal(text, opts = {}) {
  const plain = plainTextForSpeech(text)
  if (!plain) return
  const key = _oneshotCacheKey(plain, opts.speaker)
  let prepared
  const cached = _oneshotPrefetch.get(key)
  if (cached) {
    _oneshotPrefetch.delete(key)
    prepared = await cached
    // 预取得到的 Audio 可能已绑定过时状态；用 objectUrl 新建更稳
    if (prepared?.objectUrl) {
      prepared = {
        objectUrl: prepared.objectUrl,
        audio: new Audio(prepared.objectUrl),
        text: prepared.text || plain,
      }
    }
  } else {
    prepared = await _fetchSentenceAudio(plain, opts)
  }
  if (!prepared) return
  stopAssistantSpeech()
  try {
    await _playPreparedAudio({ ...prepared, text: prepared.text || plain })
  } catch (e) {
    if (e && typeof e === 'object' && /** @type {{ name?: string }} */ (e).name === 'NotAllowedError') {
      throw new Error('浏览器阻止自动播放，请再点一次麦克风或发送按钮后重试', { cause: e })
    }
    throw e
  }
}

/** Call on user gesture (e.g. mic tap) so later TTS autoplay is less likely blocked. */
export function unlockSpeechPlayback() {
  if (_playbackUnlocked) return Promise.resolve()
  const probe = new Audio()
  probe.volume = 0.001
  return probe
    .play()
    .then(() => {
      probe.pause()
      probe.src = ''
      _playbackUnlocked = true
    })
    .catch(() => {})
}

export function stopAssistantSpeech() {
  // 只 pause，不要 src=''：continuous 回声 barge 会在 play() 瞬间清 src，
  // 触发 NotSupportedError: The element has no supported sources，然后队列重试打爆 TTS。
  _playGeneration += 1
  if (!_activeAudio) {
    _setSpeaking(false)
    return
  }
  try {
    _activeAudio.pause()
  } catch {
    /* ignore */
  }
  _activeAudio = null
  _setSpeaking(false)
}

/**
 * 彻底停止所有语音播放（包括流式队列中待播放的）
 * 用户打断说话时调用：立刻停掉 AI 正在说的，清空播放队列
 * @param {{ reason?: string, skipFrame?: boolean }} [opts]
 */
export function stopAllAssistantSpeech(opts = {}) {
  const reason = String(opts.reason || 'stopAllAssistantSpeech')
  stopAssistantSpeech()
  _speechQueue.reset()
  clearAssistantSpeechPrefetch()
  // 会话 WS 通道：取消后端所有进行中的合成（barge-in / 停止播报）
  void import('./speech-session-client.js')
    .then(({ notifySpeechSessionBargeIn }) => notifySpeechSessionBargeIn({ reason }))
    .catch(() => {})
  // Frame：仅本地真在播时才 barge。空闲聆听时 skipFrame / 未播也 barge →
  // 抬 min_turn + abort 刚发出的 chat run（日志里 stopAll 风暴）。
  // 思考/播报中默认 reason 勿杀 Frame（日志 19:01:29 确认句「行」被误 barge → 正文整轮忽略）。
  if (!opts.skipFrame) {
    void import('./xiaomi-voice/index.js')
      .then(
        ({
          bargeInXiaomiFrame,
          isXiaomiFramePipelineActive,
          isXiaomiFramePlaying,
          isXiaomiFrameAwaitingReply,
          getVoicePhase,
          voiceDecisionLog,
        }) => {
          if (!isXiaomiFramePipelineActive?.()) return
          if (!isXiaomiFramePlaying?.()) return
          const phase = String(getVoicePhase?.() || '')
          const awaiting = !!isXiaomiFrameAwaitingReply?.()
          const allowFrameBarge =
            !!opts.forceFrame ||
            reason === 'wake-word-hit' ||
            reason === 'voice-exit' ||
            reason === 'voice-command-new-turn' ||
            reason === 'client_barge_in' ||
            reason === 'user-stop-tts' ||
            reason === 'ptt-mic-start' ||
            reason === 'composer-stop' ||
            reason === 'pause-listening'
          // 仍等模型正文时，匿名 stopAll 勿杀 Frame（确认句「行」被误伤 → 整轮 ignore）
          if (!allowFrameBarge && reason === 'stopAllAssistantSpeech' && awaiting) {
            voiceDecisionLog?.('stopall_skip_frame', {
              reason,
              phase,
              awaiting: 1,
              playing: 1,
            })
            return
          }
          bargeInXiaomiFrame({ reason })
        },
      )
      .catch(() => {})
  }
  // Ensure continuous-mode / follow-up idle hooks run on barge-in / UI stop.
  _notifySpeechQueueIdle()
  _ttsLog('[speech-client] 已停止所有语音播放，队列已清空', reason)
}

/** Duck TTS volume (barge-in phase 1: lower volume without stopping) */
export function duckTTS() {
  if (_activeAudio) {
    try { _activeAudio.volume = 0.08 } catch {}
  }
}

/** Restore TTS volume (barge-in noise recovery) */
export function unduckTTS() {
  if (_activeAudio) {
    try { _activeAudio.volume = 1.0 } catch {}
  }
}

/** Stop TTS completely (barge-in phase 2: real speech detected) */
export function stopTTS() {
  // continuous 回声误触很常见：只停当前正在播的一句，保留队列里后续正文。
  // 真正清空整轮请走 stopAllAssistantSpeech（PTT / 用户打断）。
  stopAssistantSpeech()
  void import('./speech-session-client.js')
    .then(({ notifySpeechSessionBargeIn }) =>
      notifySpeechSessionBargeIn({ reason: 'continuous-barge-in' }),
    )
    .catch(() => {})
  // 不 discard、不 reset：否则 ack 预取的正文被清光 → final flush=false、听感「说一句就停」
  if (!_speechQueue.holdPlayback && !_speechQueue.playing) {
    _speechQueue._kickPlay()
  }
  _ttsLog('[speech-client] stopTTS (keep queue, skipFrame)')
}

/**
 * Drop unplayed queue items and stop current audio, but keep processed cursor
 * so later appends only speak the new suffix (voice tool-mute).
 */
export function discardUnplayedStreamingSpeech() {
  stopAssistantSpeech()
  for (const s of _speechQueue.sentences) {
    if (!s.played) {
      if (s.objectUrl) {
        try {
          URL.revokeObjectURL(s.objectUrl)
        } catch {
          /* ignore */
        }
        s.objectUrl = null
      }
      s.prefetch = null
    }
  }
  _speechQueue.sentences = _speechQueue.sentences.filter((s) => s.played)
  _speechQueue.playing = false
  _speechQueue.holdPlayback = false
  _speechQueue.consecutiveFailures = 0
  _notifySpeechQueueIdle()
}

/** Hold streaming TTS playback while still allowing append/prefetch (voice ack race). */
export function holdStreamingSpeechPlayback() {
  _speechQueue.holdPlayback = true
}

/** Release hold and kick queued sentences. */
export function releaseStreamingSpeechPlayback() {
  _speechQueue.holdPlayback = false
  _speechQueue._kickPlay()
}

/** 重置流式播放队列（新会话开始时调用） */
export function resetStreamingSpeechQueue() {
  _speechQueue.reset()
}

/**
 * 重置队列并切换音色（会议室换人发言时调用）。
 * @param {string} [speaker]
 */
export function resetStreamingSpeechQueueWithSpeaker(speaker) {
  _speechQueue.reset()
  setStreamingSpeechSpeaker(speaker)
}

/** 流式追加文本并按句子播放（用于 SSE delta 场景） */
export function appendStreamingSpeech(text) {
  _speechQueue.append(text)
}

/** 流式结束时兜底播放最后一段；返回是否实际入队了新内容。 */
export function finalFlushStreamingSpeech(text) {
  return _speechQueue.finalFlush(text)
}

/** 是否仍有未入队的可播报尾巴（final 前用于跳过重复 flush）。 */
export function hasStreamingSpeechRemaining(text) {
  const remaining = _speechQueue.peekRemaining(String(text || ''))
  return remaining.length > 2
}

/** @type {AbortController | null} */
let _previewAbort = null
/** @type {number} */
let _previewGen = 0

/**
 * 试听指定音色（设置页音色选择器等）。需已配置火山 TTS API Key。
 * @param {string} text
 * @param {string} speaker voice_type
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ audio: HTMLAudioElement, speakerUsed: string }>}
 */
export async function previewSpeechTts(text, speaker, opts = {}) {
  const plain = plainTextForSpeech(text)
  if (!plain) throw new Error('试听文本为空')
  const voice = String(speaker || '').trim()
  if (!voice) throw new Error('未指定 voice_type')
  const body = { text: plain, speaker: voice, preview: true }
  const url = import.meta.env?.DEV ? '/api/speech/tts/stream' : apiUrl('/speech/tts/stream')
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  })
  const speakerUsed = res.headers.get('X-Tts-Speaker') || voice
  const digest = res.headers.get('X-Tts-Digest') || ''
  const blob = await _readTtsAudioBlob(res)
  const objectUrl = URL.createObjectURL(blob)
  const audio = new Audio(objectUrl)
  import('./audio-output.js').then((m) => m.routeAudioOutput(audio)).catch(() => {})
  audio.onended = () => URL.revokeObjectURL(objectUrl)
  audio.onerror = () => URL.revokeObjectURL(objectUrl)
  await audio.play()
  return { audio, speakerUsed, digest }
}

/**
 * @param {string} text
 * @param {{ speaker?: string }} [opts]
 * @returns {Promise<void>}
 */
export async function playAssistantSpeech(text, opts = {}) {
  const plain = plainTextForSpeech(text)
  if (!plain) return
  // 必须等到播完：确认语若只 await play() 开始就会过早触发 TTS-stop / barge-in，把正文播报掐掉
  await _playSentenceInternal(plain, opts)
}

/** Strip markdown/noise for TTS body text. */
export function plainTextForSpeech(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/[>*_~#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
