/**
 * 固定短句语音音效：TTS 合成一次后写入 IndexedDB，之后本地复用。
 * 用于唤醒「在呢」、口令停止「好的，我们下次再聊」、空闲退下「没什么事，我就先退下了」等不变文案。
 * 播报生命周期旁路上报 → POST /api/speech/playback/note（source=fixed_sfx）。
 */

import { apiUrl } from './api-client.js'
import { plainTextForSpeech } from './speech-client.js'

export const VOICE_FAREWELL_LINE = '没什么事，我就先退下了'
/** 用户说「停止 / 退出」后的友好确认（IndexedDB 缓存，首播合成一次） */
export const VOICE_STOPPED_LINE = '好的，我们下次再聊'
export const VOICE_WAKE_ACK_LINES = ['在呢', '我在', '嗯，请说']
/** 用户说完快捷应声已关闭；留空数组以免预热无用缓存 */
export const VOICE_TURN_ACK_LINES = []

const DB_NAME = 'evoflow-voice-sfx'
const DB_VER = 1
const STORE = 'clips'

/**
 * Best-effort ledger note; never throws / never blocks play.
 * @param {string} phase
 * @param {{ text?: string, utterance_id?: string, play_token?: string, speaker?: string, duration_ms?: number, bytes?: number, error?: string }} [extra]
 */
function _notePlayback(phase, extra = {}) {
  void (async () => {
    try {
      let tid = ''
      try {
        const { getVoiceTrace } = await import('./xiaomi-voice/voice-file-log.js')
        tid = typeof getVoiceTrace === 'function' ? getVoiceTrace() || '' : ''
      } catch {
        tid = ''
      }
      const body = {
        phase: String(phase || ''),
        source: 'fixed_sfx',
        text: String(extra.text || ''),
        trace_id: tid || undefined,
        utterance_id: extra.utterance_id || undefined,
        play_token: extra.play_token || undefined,
        speaker: extra.speaker || undefined,
        duration_ms: extra.duration_ms || 0,
        bytes: extra.bytes || 0,
        error: extra.error || undefined,
        provider: 'volcengine',
      }
      const url = import.meta.env?.DEV
        ? '/api/speech/playback/note'
        : apiUrl('/speech/playback/note')
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
        keepalive: true,
      })
    } catch {
      /* ignore */
    }
  })()
}

function _playToken() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** @type {Promise<IDBDatabase> | null} */
let _dbPromise = null
/** 内存层：避免同句并发重复打 TTS */
/** @type {Map<string, Promise<Blob | null>>} */
const _inflight = new Map()

function _key(text, speaker) {
  return `${String(speaker || '').trim()}::${plainTextForSpeech(text)}`
}

function _openDb() {
  if (_dbPromise) return _dbPromise
  _dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB unavailable'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VER)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('idb open failed'))
  }).catch((e) => {
    _dbPromise = null
    throw e
  })
  return _dbPromise
}

/**
 * @param {string} key
 * @returns {Promise<Blob | null>}
 */
async function _idbGet(key) {
  try {
    const db = await _openDb()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(key)
      req.onsuccess = () => {
        const row = req.result
        resolve(row?.blob instanceof Blob ? row.blob : null)
      }
      req.onerror = () => reject(req.error)
    })
  } catch {
    return null
  }
}

/**
 * @param {string} key
 * @param {Blob} blob
 */
async function _idbPut(key, blob) {
  try {
    const db = await _openDb()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({
        key,
        blob,
        mime: blob.type || 'audio/mpeg',
        ts: Date.now(),
      })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (e) {
    console.warn('[voice-sfx] idb put failed', e?.message || e)
  }
}

/**
 * 确保短句已缓存（未命中则打一次 TTS 并落盘）。
 * @param {string} text
 * @param {{ speaker?: string, play_token?: string }} [opts]
 * @returns {Promise<Blob | null>}
 */
export async function ensureFixedVoiceSfx(text, opts = {}) {
  const plain = plainTextForSpeech(text)
  if (!plain) return null
  const speaker = String(opts.speaker || '').trim()
  const key = _key(plain, speaker)

  const cached = await _idbGet(key)
  if (cached) return cached

  const hit = _inflight.get(key)
  if (hit) return hit

  const p = (async () => {
    const tok = String(opts.play_token || '').trim() || _playToken()
    _notePlayback('queued', { text: plain, speaker, play_token: tok })
    try {
      const { fetchSpeechAudioBlob } = await import('./speech-client.js')
      // 强制 HTTP 合成，禁止 speech-session（否则会另开 Frame 管线乱播固定句）
      const blob = await fetchSpeechAudioBlob(plain, { speaker })
      if (!blob || blob.size < 200) {
        _notePlayback('failed', {
          text: plain,
          speaker,
          play_token: tok,
          error: 'empty_or_short_blob',
        })
        return null
      }
      await _idbPut(key, blob)
      _notePlayback('ready', {
        text: plain,
        speaker,
        play_token: tok,
        bytes: blob.size,
      })
      try {
        const { voiceFeLog } = await import('./xiaomi-voice/voice-file-log.js')
        voiceFeLog('音效缓存', `已缓存固定句「${plain}」bytes=${blob.size}`)
      } catch {
        /* ignore */
      }
      return blob
    } catch (e) {
      console.warn('[voice-sfx] synthesize failed', plain.slice(0, 24), e?.message || e)
      _notePlayback('failed', {
        text: plain,
        speaker,
        play_token: tok,
        error: String(e?.message || e || 'synthesize_failed').slice(0, 200),
      })
      return null
    } finally {
      _inflight.delete(key)
    }
  })()
  _inflight.set(key, p)
  return p
}

/**
 * 播放固定短句（优先本地缓存；未命中则合成一次再播）。
 * @param {string} text
 * @param {{ speaker?: string }} [opts]
 */
export async function playFixedVoiceSfx(text, opts = {}) {
  const plain = plainTextForSpeech(text)
  if (!plain) return
  const speaker = String(opts.speaker || '').trim()
  const tok = _playToken()
  let blob = await ensureFixedVoiceSfx(plain, { ...opts, play_token: tok })
  if (!blob) {
    // 兜底 1：再打一次 HTTP TTS（不写缓存）
    try {
      const { playAssistantSpeech } = await import('./speech-client.js')
      _notePlayback('playing', { text: plain, speaker, play_token: tok })
      const t0 = performance.now()
      await playAssistantSpeech(plain, opts)
      _notePlayback('played', {
        text: plain,
        speaker,
        play_token: tok,
        duration_ms: Math.max(0, Math.round(performance.now() - t0)),
      })
      return
    } catch (e) {
      console.warn('[voice-sfx] HTTP fallback failed', e?.message || e)
    }
    // 兜底 2：浏览器本地朗读（HTTP 502 / 未配置时仍要有「在呢」）
    try {
      const { speakLocalWakeAckFallback } = await import('./wake-ack.js')
      if (typeof speakLocalWakeAckFallback === 'function') {
        _notePlayback('playing', { text: plain, speaker, play_token: tok })
        const t0 = performance.now()
        await speakLocalWakeAckFallback(plain)
        _notePlayback('played', {
          text: plain,
          speaker,
          play_token: tok,
          duration_ms: Math.max(0, Math.round(performance.now() - t0)),
        })
      }
    } catch (e) {
      console.warn('[voice-sfx] local speech fallback failed', e?.message || e)
      _notePlayback('failed', {
        text: plain,
        speaker,
        play_token: tok,
        error: String(e?.message || e || 'play_failed').slice(0, 200),
      })
    }
    return
  }

  const objectUrl = URL.createObjectURL(blob)
  const audio = new Audio(objectUrl)
  const t0 = performance.now()
  _notePlayback('ready', { text: plain, speaker, play_token: tok, bytes: blob.size })
  _notePlayback('playing', { text: plain, speaker, play_token: tok })
  try {
    try {
      const { routeAudioOutput } = await import('./audio-output.js')
      await routeAudioOutput(audio)
    } catch {
      /* system default */
    }
    await new Promise((resolve, reject) => {
      let settled = false
      const done = (err) => {
        if (settled) return
        settled = true
        if (err) reject(err)
        else resolve(undefined)
      }
      audio.onended = () => done()
      audio.onerror = () => done(new Error('fixed sfx play failed'))
      audio.play().catch(done)
      // 固定短句一般 < 5s；兜底避免挂死
      setTimeout(() => done(), 12000)
    })
    _notePlayback('played', {
      text: plain,
      speaker,
      play_token: tok,
      duration_ms: Math.max(0, Math.round(performance.now() - t0)),
      bytes: blob.size,
    })
  } catch (e) {
    _notePlayback('failed', {
      text: plain,
      speaker,
      play_token: tok,
      error: String(e?.message || e || 'play_failed').slice(0, 200),
    })
    console.warn('[voice-sfx] play failed', e?.message || e)
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
  }
}

/** 预热唤醒 / 停止确认 / 退下等固定句（后台，不阻塞 UI）。 */
export function prefetchFixedVoiceSfxLines(opts = {}) {
  const lines = [
    ...VOICE_WAKE_ACK_LINES,
    ...VOICE_TURN_ACK_LINES,
    VOICE_STOPPED_LINE,
    VOICE_FAREWELL_LINE,
  ]
  void (async () => {
    for (const line of lines) {
      try {
        await ensureFixedVoiceSfx(line, opts)
      } catch {
        /* ignore */
      }
    }
  })()
}
