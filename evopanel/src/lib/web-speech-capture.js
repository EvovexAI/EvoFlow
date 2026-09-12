/**
 * Hold-to-talk / mic capture via Web Speech (no Volcengine ASR).
 * Used while VOLCENGINE_ASR_ENABLED is false.
 *
 * Only one SpeechRecognition may run at a time — callers must pause the
 * wake-word ear before starting this capture.
 */

function getSpeechRecognitionCtor() {
  if (typeof window === 'undefined') return null
  return window.SpeechRecognition || window.webkitSpeechRecognition || null
}

export function isWebSpeechCaptureAvailable() {
  return !!getSpeechRecognitionCtor()
}

/**
 * @param {{
 *   onPartial?: (text: string) => void
 * }} [opts]
 */
export function startWebSpeechCapture(opts = {}) {
  const Ctor = getSpeechRecognitionCtor()
  if (!Ctor) throw new Error('当前环境不支持系统语音识别')

  const onPartial = typeof opts.onPartial === 'function' ? opts.onPartial : null
  /** @type {SpeechRecognition} */
  const rec = new Ctor()
  rec.lang = 'zh-CN'
  rec.continuous = true
  rec.interimResults = true
  rec.maxAlternatives = 1

  let finalText = ''
  let interim = ''
  let stopped = false

  const currentText = () => joinTranscript(finalText, interim).trim()

  const collectResult = (event) => {
    let nextInterim = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]
      const t = String(result?.[0]?.transcript || '').trim()
      if (!t) continue
      if (result.isFinal) {
        finalText = joinTranscript(finalText, t)
        nextInterim = ''
      } else {
        nextInterim = t
      }
    }
    interim = nextInterim
    onPartial?.(currentText())
  }

  rec.onresult = (event) => {
    collectResult(event)
  }

  rec.onerror = (ev) => {
    const err = String(ev?.error || '')
    if (err === 'not-allowed' || err === 'service-not-allowed') {
      console.warn('[web-speech-capture] permission denied')
    }
  }

  rec.onend = () => {
    if (stopped) return
    // Chrome stops after silence — keep hold-to-talk session alive until user stops.
    try {
      rec.start()
    } catch {
      setTimeout(() => {
        if (stopped) return
        try {
          rec.start()
        } catch {
          /* ignore */
        }
      }, 300)
    }
  }

  try {
    rec.start()
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e || 'SpeechRecognition start failed'))
  }

  return {
    /**
     * Stop and return transcript. Waits briefly for Chrome's final result after stop().
     * @returns {Promise<string>}
     */
    stop() {
      if (stopped) return Promise.resolve(currentText())
      stopped = true
      return new Promise((resolve) => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          try {
            rec.onend = null
            rec.onresult = null
            rec.onerror = null
          } catch {
            /* ignore */
          }
          resolve(currentText())
        }
        const timer = setTimeout(finish, 550)
        // Keep collecting finals that arrive after stop() until onend / timeout.
        rec.onend = () => finish()
        try {
          rec.stop()
        } catch {
          try {
            rec.abort()
          } catch {
            /* ignore */
          }
          finish()
        }
      })
    },
    cancel() {
      stopped = true
      try {
        rec.onend = null
        rec.onresult = null
        rec.onerror = null
        rec.abort()
      } catch {
        /* ignore */
      }
    },
  }
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
