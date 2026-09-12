/**
 * 共享语音采集：ChatComposer 与后台全局热键共用。
 */

/** @type {import('./speech-audio.js').StreamingVoiceRecorder | null} */
let streamingVoice = null
/** @type {import('./speech-audio.js').VoiceRecorder | null} */
let voiceRecorder = null
/** @type {{ stop: () => string | Promise<string>, cancel: () => void } | null} */
let webSpeechCapture = null
let voiceTranscript = ''
let startInFlight = false
let pendingStop = false
let recording = false
/** @type {Promise<{ transcript: string, error?: Error }> | null} */
let stopPromise = null
let captureGeneration = 0
/** Wake ear paused for this capture — must resume on stop/cancel unless follow-up owns it. */
let wakePausedForCapture = false

export function isVoiceCaptureActive() {
  return recording || startInFlight
}

export function isVoiceCaptureRecording() {
  return recording
}

async function pauseWakeForCapture() {
  try {
    const { cancelVoiceFollowUp } = await import('./voice-follow-up.js')
    cancelVoiceFollowUp()
  } catch {
    /* ignore */
  }
  try {
    const { abortListenOnceForCommand } = await import('./wake-word-webspeech.js')
    abortListenOnceForCommand()
  } catch {
    /* ignore */
  }
  try {
    const { pauseWakeEarForVoiceSession } = await import('./background-voice.js')
    await pauseWakeEarForVoiceSession()
  } catch {
    /* ignore */
  }
  // Let Chrome fully release the previous SpeechRecognition before starting another.
  await new Promise((r) => setTimeout(r, 350))
}

async function maybeResumeWakeAfterCapture() {
  try {
    const { isVoiceFollowUpActive } = await import('./voice-follow-up.js')
    if (isVoiceFollowUpActive()) return
  } catch {
    /* ignore */
  }
  try {
    const { resumeWakeEarAfterVoiceSession } = await import('./background-voice.js')
    await resumeWakeEarAfterVoiceSession()
  } catch {
    /* ignore */
  }
}

/**
 * @param {{ onPartial?: (text: string) => void, onLevel?: (levels: number[]) => void }} [opts]
 */
export async function startVoiceCapture(opts = {}) {
  if (stopPromise) {
    try {
      await stopPromise
    } catch {
      /* ignore */
    }
  }
  if (recording || startInFlight) return
  startInFlight = true
  const generation = ++captureGeneration
  voiceTranscript = ''
  const onPartial = typeof opts.onPartial === 'function' ? opts.onPartial : null
  const onLevel = typeof opts.onLevel === 'function' ? opts.onLevel : null
  const notifyPartial = (next) => {
    if (generation !== captureGeneration) return
    voiceTranscript = String(next || '').trim()
    onPartial?.(voiceTranscript)
  }

  try {
    // Hard barge-in: any new capture must cut assistant speech immediately.
    try {
      const { isSpeechPlaybackBusy, stopAllAssistantSpeech } = await import('./speech-client.js')
      if (isSpeechPlaybackBusy()) {
        stopAllAssistantSpeech()
        try {
          const { notifyTTSStopped } = await import('./background-voice.js')
          notifyTTSStopped()
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }

    // Mic / Alt+X must free the wake-word ear (esp. Web Speech) or recognition stays empty.
    await pauseWakeForCapture()
    wakePausedForCapture = true

    const { isVolcengineAsrEnabled } = await import('./voice-asr-policy.js')
    const preferVolc = isVolcengineAsrEnabled()

    const startWebSpeech = async () => {
      const { startWebSpeechCapture, isWebSpeechCaptureAvailable } = await import(
        './web-speech-capture.js'
      )
      if (!isWebSpeechCaptureAvailable()) {
        throw new Error('当前环境不支持系统语音识别')
      }
      webSpeechCapture = startWebSpeechCapture({ onPartial: notifyPartial })
      recording = true
    }

    if (!preferVolc) {
      await startWebSpeech()
      return
    }

    const { speechStreamingAsrCached, fetchSpeechConfigured, unlockSpeechPlayback } = await import(
      './speech-client.js'
    )
    let configured = await fetchSpeechConfigured()
    let useStreaming = speechStreamingAsrCached()

    if (!configured || useStreaming == null) {
      configured = await fetchSpeechConfigured()
      useStreaming = speechStreamingAsrCached()
    }

    // Volcengine not ready → Web Speech fallback (still better than failing closed).
    if (!configured) {
      console.warn('[voice-capture] Volcengine speech not configured; falling back to Web Speech')
      await startWebSpeech()
      return
    }

    if (useStreaming) {
      try {
        const { StreamingVoiceRecorder } = await import('./speech-audio.js')
        const streamer = new StreamingVoiceRecorder()
        streamingVoice = streamer
        await streamer.start({
          baseText: '',
          onPartial: notifyPartial,
          onLevel,
          onError: (err) => console.warn('[voice-capture] stream', err),
        })
        void unlockSpeechPlayback().catch(() => {})
        recording = true
      } catch (e) {
        console.warn('[voice-capture] stream start', e)
        streamingVoice?.cancel()
        streamingVoice = null
        const { isMicrophoneAccessError, microphoneErrorMessage } = await import('./speech-audio.js')
        if (isMicrophoneAccessError(e)) {
          const err = new Error(microphoneErrorMessage(e))
          if (e && typeof e === 'object' && e.name) err.name = String(e.name)
          throw err
        }
        if (!voiceRecorder) {
          const { VoiceRecorder } = await import('./speech-audio.js')
          voiceRecorder = new VoiceRecorder()
        }
        await voiceRecorder.start({ onLevel })
        void unlockSpeechPlayback().catch(() => {})
        recording = true
      }
    } else {
      if (!voiceRecorder) {
        const { VoiceRecorder } = await import('./speech-audio.js')
        voiceRecorder = new VoiceRecorder()
      }
      await voiceRecorder.start({ onLevel })
      void unlockSpeechPlayback().catch(() => {})
      recording = true
    }
  } catch (e) {
    if (wakePausedForCapture) {
      wakePausedForCapture = false
      await maybeResumeWakeAfterCapture()
    }
    throw e
  } finally {
    startInFlight = false
  }
}

async function waitForVoiceCaptureStart(maxMs = 15000) {
  const step = 30
  let waited = 0
  while (startInFlight && waited < maxMs) {
    await new Promise((r) => setTimeout(r, step))
    waited += step
  }
}

export function getVoicePartialTranscript() {
  return String(voiceTranscript || '').trim()
}

/**
 * @param {{ keepWakePaused?: boolean }} [opts] keepWakePaused: caller will start follow-up / keep owning the mic
 * @returns {Promise<{ transcript: string, error?: Error }>}
 */
export async function stopVoiceCapture(opts = {}) {
  if (stopPromise) return stopPromise

  const keepWakePaused = opts.keepWakePaused === true

  stopPromise = (async () => {
    if (startInFlight) {
      pendingStop = true
      await waitForVoiceCaptureStart()
    }
    pendingStop = false
    captureGeneration += 1

    if (!recording && !streamingVoice && !voiceRecorder?.recording && !webSpeechCapture) {
      const tail = getVoicePartialTranscript()
      voiceTranscript = ''
      if (wakePausedForCapture && !keepWakePaused) {
        wakePausedForCapture = false
        await maybeResumeWakeAfterCapture()
      }
      return { transcript: tail }
    }

    const snapshot = getVoicePartialTranscript()
    recording = false

    try {
      if (webSpeechCapture) {
        const session = webSpeechCapture
        webSpeechCapture = null
        const raw = await Promise.resolve(session.stop())
        const transcript = String(raw || '').trim()
        voiceTranscript = ''
        return { transcript: transcript || snapshot }
      }
      if (streamingVoice?.recording) {
        const streamer = streamingVoice
        streamingVoice = null
        const transcript = String(await streamer.stop()).trim()
        voiceTranscript = ''
        return { transcript: transcript || snapshot }
      }
      if (voiceRecorder?.recording) {
        const wav = await voiceRecorder.stop()
        if (wav) {
          const { transcribeSpeechAudio } = await import('./speech-client.js')
          const transcript = await transcribeSpeechAudio(wav)
          voiceTranscript = ''
          return { transcript: String(transcript || '').trim() }
        }
      }
      voiceTranscript = ''
      return { transcript: snapshot }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e || 'voice stop failed'))
      voiceTranscript = ''
      streamingVoice = null
      webSpeechCapture = null
      return { transcript: snapshot, error: err }
    } finally {
      voiceTranscript = ''
      if (wakePausedForCapture && !keepWakePaused) {
        wakePausedForCapture = false
        await maybeResumeWakeAfterCapture()
      } else if (keepWakePaused) {
        // Follow-up session inherits the paused wake ear.
        wakePausedForCapture = false
      }
    }
  })()

  try {
    return await stopPromise
  } finally {
    stopPromise = null
  }
}

export function cancelVoiceCapture() {
  pendingStop = false
  captureGeneration += 1
  voiceTranscript = ''
  if (webSpeechCapture) {
    webSpeechCapture.cancel()
    webSpeechCapture = null
  }
  streamingVoice?.cancel()
  streamingVoice = null
  if (voiceRecorder?.recording) {
    void voiceRecorder.stop().catch(() => {})
  }
  recording = false
  startInFlight = false
  if (wakePausedForCapture) {
    wakePausedForCapture = false
    void maybeResumeWakeAfterCapture()
  }
}

// ─── 持续监听模式 ───

/** @type {import('./speech-audio.js').StreamingVoiceRecorder | null} */
let continuousVoice = null
/** @type {((vol: number) => void) | null} */
let continuousOnFrame = null
/** @type {(() => void) | null} */
let continuousOnFinal = null
/** @type {boolean} */
let continuousActive = false

export function isContinuousCaptureActive() {
  return continuousActive
}

/**
 * Start continuous listening: mic stays open, ASR streams,
 * partial transcripts via onPartial, volume via onFrame.
 * @param {{
 *   onPartial?: (text: string) => void,
 *   onFinal?: () => void,
 *   onFrame?: (vol: number) => void,
 *   onError?: (err: Error) => void,
 * }} [opts]
 */
export async function startContinuousCapture(opts = {}) {
  if (continuousActive) return
  continuousActive = true
  continuousOnFrame = typeof opts.onFrame === 'function' ? opts.onFrame : null
  continuousOnFinal = typeof opts.onFinal === 'function' ? opts.onFinal : null

  const { isVolcengineAsrEnabled } = await import('./voice-asr-policy.js')
  if (!isVolcengineAsrEnabled()) {
    continuousActive = false
    throw new Error('持续监听需要火山流式识别（当前策略已关闭）')
  }

  const { fetchSpeechConfigured, speechStreamingAsrCached, unlockSpeechPlayback } = await import(
    './speech-client.js'
  )
  let useStreaming = speechStreamingAsrCached()
  if (useStreaming == null) {
    await fetchSpeechConfigured()
    useStreaming = speechStreamingAsrCached()
  }
  if (!useStreaming) {
    continuousActive = false
    throw new Error('持续监听需要流式 ASR，请在设置中配置火山语音')
  }

  try {
    const { StreamingVoiceRecorder } = await import('./speech-audio.js')
    continuousVoice = new StreamingVoiceRecorder()
    await continuousVoice.start({
      onPartial: (text) => {
        voiceTranscript = String(text || '').trim()
        opts.onPartial?.(voiceTranscript)
      },
      onFinal: () => {
        continuousOnFinal?.()
      },
      onLevel: (levels) => {
        if (continuousOnFrame) {
          const avg = levels.reduce((a, b) => a + b, 0) / levels.length
          continuousOnFrame(avg)
        }
      },
      onError: (err) => {
        console.warn('[voice-continuous] error', err)
        opts.onError?.(err)
      },
    })
    void unlockSpeechPlayback().catch(() => {})
    recording = true
  } catch (e) {
    continuousActive = false
    continuousVoice?.cancel()
    continuousVoice = null
    throw e
  }
}

/**
 * Get the current partial transcript from continuous session.
 * @returns {string}
 */
export function getContinuousTranscript() {
  return String(voiceTranscript || '').trim()
}

/**
 * Reset the accumulated transcript (after auto-send).
 */
export function resetContinuousTranscript() {
  voiceTranscript = ''
}

/**
 * Stop continuous listening session.
 */
export async function stopContinuousCapture() {
  if (!continuousActive) return
  continuousActive = false
  continuousOnFrame = null
  continuousOnFinal = null
  voiceTranscript = ''
  if (continuousVoice?.recording) {
    void continuousVoice.stop().catch(() => {})
  }
  continuousVoice = null
  recording = false
}

/**
 * 获取持续监听的 recorder 实例（供 background-voice 挂起/恢复用）。
 * @returns {import('./speech-audio.js').StreamingVoiceRecorder | null}
 */
export function getContinuousRecorder() {
  return continuousVoice
}

/**
 * 获取当前活跃的流式 recorder（PTT/持续模式通用）。
 * @returns {import('./speech-audio.js').StreamingVoiceRecorder | null}
 */
export function getActiveStreamingRecorder() {
  return continuousVoice || streamingVoice
}
