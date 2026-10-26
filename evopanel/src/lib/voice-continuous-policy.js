/**
 * 持续监听策略 —— 对齐白龙马 `voice-continuous.js`：
 * 1. 转写停更 SILENCE_SEND_MS（默认 2s）后整条发出
 * 2. TTS 期间两阶段 barge：warmup → duck → 持续高振幅才 stopTTS
 *
 * 参数与白龙马同源，勿擅自「优化」成更激进的打断（回声会误掐播报）。
 */

// ─── 自动发送（白龙马默认 2s；≥800） ───
const SILENCE_SEND_MS = (() => {
  const v = parseInt(localStorage.getItem('evoflow-voice-silence-ms') || '', 10)
  return Number.isFinite(v) && v >= 800 ? v : 2000
})()
/** 火山 final 常在句中就出：宽限内来新转写则取消快发 */
const FAST_SEND_AFTER_FINAL_MS = 400

// ─── 打断检测（对齐 bailongma/src/ui/brain-ui/voice-continuous.js） ───
const BARGEIN_THRESHOLD = 0.09
const BARGEIN_WARMUP_MS = 600

const DUCK_TRIGGER_FRAMES = 3
const DUCK_SUSTAIN_FRAMES = 10
const DUCK_DECAY_FRAMES = 6
const DUCK_MAX_MS = 1500
const ECHO_MARGIN_VOL = 0.025
const ECHO_HARD_VOL = 0.16

const BARGEIN_NO_SPEECH_MS = 3500

/**
 * @param {{
 *   getText: () => string,
 *   sendText: (text: string) => void,
 *   duckTTS: () => void,
 *   unduckTTS: () => void,
 *   stopTTS: () => void,
 *   onProcessing?: () => void,
 *   isPttHolding?: () => boolean,
 * }} opts
 */
export function createContinuousPolicy(opts) {
  const { getText, sendText, duckTTS, unduckTTS, stopTTS, onProcessing, isPttHolding } = opts

  let autoSendTimer = null
  let lastTranscriptActivityTs = 0
  let lastObservedText = ''
  let fastSendTimer = null

  let bargeinFrames = 0
  let duckActive = false
  let duckHighFrames = 0
  let duckLowFrames = 0
  let duckStartTime = 0
  let ttsEchoFloor = 0
  let ttsActive = false
  let ttsStartTime = 0

  let bargeinNoSpeechTimer = null

  function cancelAutoSend() {
    if (autoSendTimer) {
      clearTimeout(autoSendTimer)
      autoSendTimer = null
    }
  }

  function cancelFastSend() {
    if (fastSendTimer) {
      clearTimeout(fastSendTimer)
      fastSendTimer = null
    }
  }

  function fireSend() {
    cancelAutoSend()
    cancelFastSend()
    autoSendTimer = null
    lastObservedText = ''
    const text = (getText?.() || '').trim()
    if (text) {
      onProcessing?.()
      sendText(text)
    }
  }

  function clearNoSpeechTimer() {
    if (bargeinNoSpeechTimer) {
      clearTimeout(bargeinNoSpeechTimer)
      bargeinNoSpeechTimer = null
    }
  }

  function resetEchoFloor() {
    ttsEchoFloor = 0
  }

  function learnEchoFloor(vol, { force = false } = {}) {
    const raw = Math.max(0, Number(vol) || 0)
    if (!force && raw > BARGEIN_THRESHOLD) return
    const sample = Math.min(raw, BARGEIN_THRESHOLD)
    ttsEchoFloor = ttsEchoFloor ? ttsEchoFloor * 0.9 + sample * 0.1 : sample
  }

  function isBargeinCandidate(vol) {
    if (vol <= BARGEIN_THRESHOLD) return false
    if (!ttsActive) return true
    const guard = Math.max(BARGEIN_THRESHOLD, ttsEchoFloor + ECHO_MARGIN_VOL)
    return vol >= ECHO_HARD_VOL || vol > guard
  }

  function onTTSStart() {
    ttsActive = true
    ttsStartTime = Date.now()
    resetEchoFloor()
    bargeinFrames = 0
    duckActive = false
    duckHighFrames = 0
    duckLowFrames = 0
  }

  function onTTSStop() {
    ttsActive = false
    if (duckActive) {
      unduckTTS?.()
      duckActive = false
    }
    resetEchoFloor()
  }

  function onFrame(vol) {
    if (!ttsActive) return

    const aecReady = Date.now() - ttsStartTime > BARGEIN_WARMUP_MS

    if (aecReady && !duckActive) {
      learnEchoFloor(vol, { force: !aecReady })
    }

    if (!aecReady) {
      learnEchoFloor(vol, { force: true })
      return
    }

    const candidate = isBargeinCandidate(vol)

    if (!duckActive) {
      if (candidate) {
        if (++bargeinFrames >= DUCK_TRIGGER_FRAMES) {
          bargeinFrames = 0
          duckActive = true
          duckStartTime = Date.now()
          duckHighFrames = 0
          duckLowFrames = 0
          duckTTS?.()
        }
      } else {
        bargeinFrames = 0
      }
    } else {
      const elapsed = Date.now() - duckStartTime
      if (candidate) {
        duckHighFrames++
        duckLowFrames = 0
        if (duckHighFrames >= DUCK_SUSTAIN_FRAMES) {
          duckActive = false
          duckHighFrames = 0
          onTTSStop()
          stopTTS?.()
          clearNoSpeechTimer()
          bargeinNoSpeechTimer = setTimeout(() => {
            bargeinNoSpeechTimer = null
            // 白龙马：resumeTTSIfNoSpeech；Frame 路径暂不续播，用户可再说一句
          }, BARGEIN_NO_SPEECH_MS)
        }
      } else {
        duckLowFrames++
        duckHighFrames = 0
        if (duckLowFrames >= DUCK_DECAY_FRAMES || elapsed >= DUCK_MAX_MS) {
          duckActive = false
          duckLowFrames = 0
          unduckTTS?.()
        }
      }
    }
  }

  function onTranscript() {
    if (isPttHolding?.()) {
      cancelAutoSend()
      cancelFastSend()
      return
    }
    const text = (getText?.() || '').trim()
    if (text === lastObservedText) return
    lastObservedText = text
    lastTranscriptActivityTs = Date.now()
    cancelFastSend()
    if (!text) {
      cancelAutoSend()
      return
    }
    if (autoSendTimer) return
    const tick = () => {
      const idle = Date.now() - lastTranscriptActivityTs
      if (idle >= SILENCE_SEND_MS) {
        autoSendTimer = null
        fireSend()
      } else {
        autoSendTimer = setTimeout(tick, SILENCE_SEND_MS - idle)
      }
    }
    autoSendTimer = setTimeout(tick, SILENCE_SEND_MS)
  }

  function onFinal() {
    if (isPttHolding?.()) return
    cancelFastSend()
    const text = (getText?.() || '').trim()
    if (!text) return
    fastSendTimer = setTimeout(() => {
      fastSendTimer = null
      fireSend()
    }, FAST_SEND_AFTER_FINAL_MS)
  }

  function cancelAutoSendPublic() {
    cancelAutoSend()
    cancelFastSend()
  }

  function reset() {
    cancelAutoSend()
    cancelFastSend()
    clearNoSpeechTimer()
    lastObservedText = ''
    lastTranscriptActivityTs = 0
    bargeinFrames = 0
    duckActive = false
    duckHighFrames = 0
    duckLowFrames = 0
    ttsActive = false
    resetEchoFloor()
  }

  return {
    onFrame,
    onTranscript,
    onFinal,
    onTTSStart,
    onTTSStop,
    cancelAutoSend: cancelAutoSendPublic,
    reset,
  }
}
