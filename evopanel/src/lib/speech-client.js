/**
 * Gateway speech API client (Volcengine ASR/TTS for chat).
 */

import { apiUrl } from './api-client.js'

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

/** 从 pos 起切下一段可播报文本；无完整句时积累够长也会在停顿符/硬切点断开 */
export function advanceSpeechChunk(clean, pos) {
  if (!clean || pos >= clean.length) return pos
  for (let i = pos; i < clean.length; i++) {
    const ch = clean[i]
    if (ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?' || ch === '\n') {
      return i + 1
    }
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
}

export function getStreamingSpeechSpeaker() {
  return _queueSpeaker
}

/**
 * @param {string} text
 * @param {{ speaker?: string }} [opts]
 * @returns {Promise<{ objectUrl: string, audio: HTMLAudioElement } | null>}
 */
async function _fetchSentenceAudio(text, opts = {}) {
  const plain = plainTextForSpeech(text)
  if (!plain) return null
  const speaker = String(opts.speaker || _queueSpeaker || '').trim()
  // Non-stream /tts returns a complete mp3; HTMLAudioElement handles it more reliably
  // than a blob assembled from /tts/stream (truncated streams can hang without onended).
  const url = import.meta.env?.DEV ? '/api/speech/tts' : apiUrl('/speech/tts')
  console.log(
    '[speech-queue] tts fetch',
    JSON.stringify(plain.slice(0, 40)),
    speaker ? `speaker=${speaker}` : 'speaker=default',
  )
  /** @type {Record<string, string>} */
  const body = { text: plain }
  if (speaker) body.speaker = speaker
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const blob = await _readTtsAudioBlob(res)
  console.log('[speech-queue] tts ok bytes=', blob.size)
  const objectUrl = URL.createObjectURL(blob)
  const audio = new Audio(objectUrl)
  return { objectUrl, audio }
}

/**
 * @param {{ objectUrl: string, audio: HTMLAudioElement }} prepared
 * @param {{ timeoutMs?: number }} [opts]
 */
async function _playPreparedAudio(prepared, opts = {}) {
  const { objectUrl, audio } = prepared
  const timeoutMs = Math.max(8000, Number(opts.timeoutMs) || 90000)
  _activeAudio = audio
  audio.volume = 1
  _setSpeaking(true)

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
            console.log('[speech-queue] play ended via duration fallback')
            done()
          }
        }, ms)
      }
      armHangTimer(timeoutMs, true)

      audio.onended = () => {
        console.log('[speech-queue] play ended')
        done()
      }
      audio.onerror = () => done(new Error('Audio playback failed'))
      audio.onloadedmetadata = () => {
        const dur = Number(audio.duration)
        console.log('[speech-queue] play metadata duration=', dur)
        if (!Number.isFinite(dur) || dur <= 0) {
          done(new Error('TTS audio duration is 0'))
          return
        }
        // onended 偶发不触发：按时长正常结束，避免 playing=true 堵死整条队列
        armHangTimer(Math.ceil(dur * 1000) + 1500, false)
      }

      console.log('[speech-queue] play start')
      audio.play().catch((e) => done(e))
    })
  } finally {
    try {
      audio.pause()
    } catch {
      /* ignore */
    }
    try {
      URL.revokeObjectURL(objectUrl)
    } catch {
      /* ignore */
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

/** Whether assistant TTS (single-shot or streaming queue) is active / pending. */
export function isSpeechPlaybackBusy() {
  if (_speaking || _speechQueue.playing) return true
  return _speechQueue.sentences.some((s) => !s.played)
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
    const tail = this.sentences[this.sentences.length - 1]
    if (tail?.text === item.text) return
    if (
      tail &&
      !tail.played &&
      !tail.prefetch &&
      tail.text.length + item.text.length <= 96
    ) {
      tail.text = `${tail.text}${item.text}`
      return
    }
    this.sentences.push(item)
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
      const end = advanceSpeechChunk(clean, pos)
      if (end <= pos) break

      const chunk = clean.slice(pos, end).trim()
      if (chunk.length >= 2) {
        console.log('[speech-queue] append chunk:', JSON.stringify(chunk), 'pos:', pos, '->', end)
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
    console.log(
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
      console.log('[speech-queue] finalFlush: skip duplicate remaining, kick unplayed')
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

  async _tryPlayNext() {
    if (this.playing || this.holdPlayback) return
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      console.warn('[speech-queue] 连续播放失败超过', this.maxConsecutiveFailures, '次，停止自动播放')
      _notifySpeechQueueIdle()
      return
    }

    const nextIdx = this.sentences.findIndex((s) => !s.played)
    if (nextIdx < 0 || nextIdx <= this.lastPlayedIndex) {
      if (nextIdx < 0) _notifySpeechQueueIdle()
      return
    }

    const sentence = this.sentences[nextIdx]
    if (sentence.text.trim().length < 2) {
      sentence.played = true
      this.lastPlayedIndex = nextIdx
      this._tryPlayNext()
      return
    }

    this.playing = true
    sentence.played = true
    this.lastPlayedIndex = nextIdx
    this._schedulePrefetch(nextIdx + 1)

    try {
      // 清掉确认语等残留 Audio，避免占着 _activeAudio 或被 barge-in 误杀后队列卡住
      stopAssistantSpeech()
      const prepared = await this._ensurePrepared(sentence)
      await _playPreparedAudio(prepared)
      sentence.objectUrl = null
      this.consecutiveFailures = 0
    } catch (e) {
      console.warn('[speech-queue] play failed', e)
      this.consecutiveFailures++
    } finally {
      this.playing = false
      if (this.consecutiveFailures < this.maxConsecutiveFailures) {
        const more = this.sentences.findIndex((s) => !s.played)
        if (more >= 0) this._tryPlayNext()
        else _notifySpeechQueueIdle()
      } else {
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
      prepared = { objectUrl: prepared.objectUrl, audio: new Audio(prepared.objectUrl) }
    }
  } else {
    prepared = await _fetchSentenceAudio(plain, opts)
  }
  if (!prepared) return
  stopAssistantSpeech()
  try {
    await _playPreparedAudio(prepared)
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
  if (!_activeAudio) return
  try {
    _activeAudio.pause()
    _activeAudio.src = ''
  } catch {
    /* ignore */
  }
  _activeAudio = null
  _setSpeaking(false)
}

/**
 * 彻底停止所有语音播放（包括流式队列中待播放的）
 * 用户打断说话时调用：立刻停掉 AI 正在说的，清空播放队列
 */
export function stopAllAssistantSpeech() {
  stopAssistantSpeech()
  _speechQueue.reset()
  clearAssistantSpeechPrefetch()
  // Ensure continuous-mode / follow-up idle hooks run on barge-in / UI stop.
  _notifySpeechQueueIdle()
  console.log('[speech-client] 已停止所有语音播放，队列已清空')
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
  stopAllAssistantSpeech()
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
