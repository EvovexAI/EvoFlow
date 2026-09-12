/**
 * Wake-word fallback via Web Speech API (no sherpa-onnx WASM).
 *
 * Used when `public/kws/sherpa-onnx-wasm-kws-main.{js,wasm}` is missing
 * (common when HuggingFace is unreachable). Dispatches the same
 * `wake-word-hit` event as the local KWS ear.
 */

const WAKE_WORD_LABEL = '小V小V'
const COOLDOWN_MS = 2500

/** Phrases that open continuous voice (normalized, no punctuation). */
const WAKE_PHRASES = [
  '小V小V',
  '小v小v',
  '小维小维', // spoken “V” ≈ 维
  '小微小微',
  '小委小委',
  '小威小威',
  '嘿小V',
  '嗨小V',
  '你好小V',
  '你好小v',
  // Chrome ASR often hears 「小V」 as 蜜/米 — still treat as wake (product name is 小V)
  '小蜜小蜜',
  '小米小米',
]

/** @type {SpeechRecognition | null} */
let recognition = null
let running = false
let lastHitTime = 0
/** @type {'webspeech' | null} */
let backend = null

function getSpeechRecognitionCtor() {
  if (typeof window === 'undefined') return null
  return window.SpeechRecognition || window.webkitSpeechRecognition || null
}

export function isWebSpeechWakeAvailable() {
  return !!getSpeechRecognitionCtor()
}

function normalizeZh(text) {
  return String(text || '')
    .replace(/[\s\u3000，,。.！!？?、·\-_/\\'"`~]+/g, '')
    .toLowerCase()
}

function matchWakePhrase(text) {
  const n = normalizeZh(text)
  if (!n) return null
  for (const phrase of WAKE_PHRASES) {
    if (n.includes(normalizeZh(phrase))) return WAKE_WORD_LABEL
  }
  // 「小V」×2 with Latin/Chinese V variants, even if ASR inserts odd chars
  if (/小[vV维微委威蜜米]小[vV维微委威蜜米]/.test(n)) return WAKE_WORD_LABEL
  return null
}

function emitHit(keyword) {
  const now = Date.now()
  if (now - lastHitTime < COOLDOWN_MS) return
  lastHitTime = now
  const label = WAKE_WORD_LABEL
  console.log('[wake-word-webspeech] HIT:', label)
  window.dispatchEvent(
    new CustomEvent('wake-word-hit', {
      detail: { keyword: label, backend: 'webspeech', asr: keyword || label },
    }),
  )
}

/**
 * @returns {Promise<boolean>}
 */
export async function startWebSpeechEar() {
  if (running) return true
  const Ctor = getSpeechRecognitionCtor()
  if (!Ctor) {
    console.warn('[wake-word-webspeech] SpeechRecognition unavailable')
    return false
  }

  try {
    const rec = new Ctor()
    rec.lang = 'zh-CN'
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 3

    rec.onresult = (event) => {
      if (!running) return
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (!result) continue
        for (let j = 0; j < result.length; j++) {
          const transcript = result[j]?.transcript || ''
          const hit = matchWakePhrase(transcript)
          if (hit) {
            emitHit(hit)
            return
          }
        }
      }
    }

    rec.onerror = (ev) => {
      const err = String(ev?.error || '')
      // `no-speech` / `aborted` are normal; `not-allowed` means mic denied.
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        console.warn('[wake-word-webspeech] mic/permission denied:', err)
        stopWebSpeechEar()
      }
    }

    rec.onend = () => {
      if (!running) return
      // Chrome stops after silence — restart the ear.
      try {
        rec.start()
      } catch {
        setTimeout(() => {
          if (!running) return
          try {
            rec.start()
          } catch {
            /* ignore */
          }
        }, 400)
      }
    }

    recognition = rec
    running = true
    backend = 'webspeech'
    rec.start()
    console.log('[wake-word-webspeech] Ear listening for', WAKE_WORD_LABEL)
    return true
  } catch (e) {
    console.warn(
      '[wake-word-webspeech] Failed to start:',
      e instanceof Error ? e.message : String(e),
    )
    stopWebSpeechEar()
    return false
  }
}

export function stopWebSpeechEar() {
  running = false
  backend = null
  const rec = recognition
  recognition = null
  if (!rec) return
  try {
    rec.onend = null
    rec.onresult = null
    rec.onerror = null
    rec.stop()
  } catch {
    try {
      rec.abort()
    } catch {
      /* ignore */
    }
  }
}

export function isWebSpeechEarRunning() {
  return running
}

export function webSpeechWakeBackend() {
  return backend
}

/**
 * One-shot command listen after wake (stay on Web Speech — avoid Volcengine
 * streaming handoff which stalls when mic was just held by SpeechRecognition).
 *
 * @param {{
 *   timeoutMs?: number
 *   onPartial?: (text: string) => void
 * }} [opts]
 * @returns {Promise<string>}
 */
/** @type {(() => void) | null} */
let abortActiveCommandListen = null

/** Stop an in-flight listenOnceForCommand (e.g. user pressed Alt+X / mic). */
export function abortListenOnceForCommand() {
  try {
    abortActiveCommandListen?.()
  } catch {
    /* ignore */
  }
  abortActiveCommandListen = null
}

export function listenOnceForCommand(opts = {}) {
  abortListenOnceForCommand()
  const timeoutMs = Math.max(4000, Number(opts.timeoutMs) || 12000)
  const onPartial = typeof opts.onPartial === 'function' ? opts.onPartial : null
  const Ctor = getSpeechRecognitionCtor()
  if (!Ctor) return Promise.reject(new Error('SpeechRecognition unavailable'))

  return new Promise((resolve, reject) => {
    /** @type {SpeechRecognition} */
    const rec = new Ctor()
    rec.lang = 'zh-CN'
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1

    let settled = false
    let best = ''
    let silenceTimer = null
    const startedAt = Date.now()

    const finish = (text) => {
      if (settled) return
      settled = true
      if (abortActiveCommandListen === abortFn) abortActiveCommandListen = null
      clearTimeout(hardTimer)
      if (silenceTimer) clearTimeout(silenceTimer)
      try {
        rec.onend = null
        rec.onresult = null
        rec.onerror = null
        rec.stop()
      } catch {
        try {
          rec.abort()
        } catch {
          /* ignore */
        }
      }
      resolve(stripWakePrefix(String(text || '').trim()))
    }

    const abortFn = () => finish(best)
    abortActiveCommandListen = abortFn

    const hardTimer = setTimeout(() => finish(best), timeoutMs)

    const scheduleSilenceCommit = () => {
      if (silenceTimer) clearTimeout(silenceTimer)
      // Commit shortly after speech pauses (Web Speech often ends the session itself).
      silenceTimer = setTimeout(() => {
        if (best.trim()) finish(best)
      }, 1600)
    }

    rec.onresult = (event) => {
      let chunk = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const t = String(result?.[0]?.transcript || '').trim()
        if (!t) continue
        if (result.isFinal) {
          best = joinTranscript(best, t)
          chunk = best
          scheduleSilenceCommit()
        } else {
          chunk = joinTranscript(best, t)
        }
      }
      if (chunk) onPartial?.(stripWakePrefix(chunk))
      // If we already have a solid non-wake command, don't wait forever.
      const cleaned = stripWakePrefix(best)
      if (cleaned.length >= 2 && Date.now() - startedAt > 2500) {
        scheduleSilenceCommit()
      }
    }

    rec.onerror = (ev) => {
      const err = String(ev?.error || '')
      if (err === 'no-speech' || err === 'aborted') {
        finish(best)
        return
      }
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        if (!settled) {
          settled = true
          if (abortActiveCommandListen === abortFn) abortActiveCommandListen = null
          clearTimeout(hardTimer)
          reject(new Error('麦克风权限被拒绝'))
        }
        return
      }
      // Other errors: still return whatever we have.
      finish(best)
    }

    rec.onend = () => {
      // Chrome ends after a pause — treat as end of utterance.
      finish(best)
    }

    try {
      rec.start()
    } catch (e) {
      clearTimeout(hardTimer)
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

function joinTranscript(prev, next) {
  const a = String(prev || '').trim()
  const b = String(next || '').trim()
  if (!a) return b
  if (!b) return a
  if (b.startsWith(a)) return b
  if (a.endsWith(b)) return a
  return `${a}${b}`
}

/** Remove leading wake phrase so we don't send "小V小V打开灯" as-is when redundant. */
function stripWakePrefix(text) {
  let s = String(text || '').trim()
  if (!s) return ''
  const n = normalizeZh(s)
  for (const phrase of WAKE_PHRASES) {
    const p = normalizeZh(phrase)
    if (n === p) return ''
    if (n.startsWith(p)) {
      // Best-effort: strip matching prefix chars from original (punctuation tolerant).
      let i = 0
      let matched = 0
      while (i < s.length && matched < phrase.length) {
        const ch = s[i]
        if (/[\s\u3000，,。.！!？?、·]/.test(ch)) {
          i += 1
          continue
        }
        if (ch === phrase[matched]) {
          matched += 1
          i += 1
          continue
        }
        break
      }
      if (matched >= phrase.length) {
        s = s.slice(i).replace(/^[\s，,。.！!？?、]+/, '')
      }
    }
  }
  return s.trim()
}
