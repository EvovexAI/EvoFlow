/**
 * 桌面端后台语音助手：全局热键 → 录音 → 确认语 → 派活 → 托盘状态。
 */

import { isTauri } from './panel-login.js'
import {
  getShortcutBinding,
  KEYBOARD_SHORTCUTS_CHANGED,
} from './keyboard-shortcuts.js'
import {
  cancelVoiceCapture,
  isVoiceCaptureActive,
  startVoiceCapture,
  stopVoiceCapture,
} from './voice-capture-service.js'
import {
  demoTranscriptResult,
  isVoiceDemoActive,
  startVoiceDemo,
  stopVoiceDemo,
} from './voice-demo-mode.js'
import {
  beginVoicePartialSession,
  endVoicePartialSession,
  isVoiceSendHandlerReady,
  isXiaomiVoiceSendHandlerReady,
  sendVoiceTranscript,
  setPreferXiaomiVoice,
  updateVoicePartialText,
} from './background-voice-bridge.js'
import { getPanelSetting } from './panel-settings.js'
import {
  startContinuousCapture,
  stopContinuousCapture,
  getContinuousTranscript,
  resetContinuousTranscript,
  isContinuousCaptureActive,
  getContinuousRecorder,
  getVoicePartialTranscript,
  getActiveStreamingRecorder,
} from './voice-capture-service.js'
import { createContinuousPolicy } from './voice-continuous-policy.js'
import { createPttController, PTT_SHORT_PRESS_HINT } from './voice-ptt.js'

// ── Wake word ──
/** @type {boolean} */
let wakeWordEnabled = false

const TRAY_BASE = 'EvoFlow'

/** @type {boolean} */
let inited = false

/**
 * PTT 控制器（策略模块）。
 * PTT 内部状态（pushDown / pushDownTimeout / voiceStopInFlight / releaseChain）
 * 全部封装在 voice-ptt.js 内部，background-voice.js 只做编排转发。
 * @type {ReturnType<typeof createPttController> | null}
 */
let pttController = null

const OVERLAY_COMPLETE_MS = 0

async function loadOverlayModule() {
  return import('../components/voice-recording-overlay.js')
}

async function tauriInvoke() {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke
}

/** 显示外置语音浮窗（Tauri）或应用内降级 */
export async function showVoiceInputOverlay(_text) {
  if (isTauri) {
    try {
      const invoke = await tauriInvoke()
      await invoke('voice_overlay_show', { text: null })
      return loadOverlayModule()
    } catch (e) {
      console.warn('[background-voice] 外置浮窗失败，降级应用内', e)
    }
  }
  const overlayModule = await loadOverlayModule()
  const { showVoiceRecordingOverlay } = overlayModule
  showVoiceRecordingOverlay()
  return overlayModule
}

/** 隐藏语音浮窗 */
export async function hideVoiceInputOverlay() {
  if (isTauri) {
    try {
      const invoke = await tauriInvoke()
      await invoke('voice_overlay_hide')
      return
    } catch (_) {}
  }
  const { hideVoiceRecordingOverlay } = await loadOverlayModule()
  hideVoiceRecordingOverlay()
}

/** 不推送实时文字（外置浮窗仅保留动效） */
export function updateVoiceInputOverlayText(_text) {}

/** 不推送频谱（外置浮窗自带动画，避免 IPC 卡顿） */
export function updateVoiceInputOverlayLevels(_levels) {}

/** 松手后立刻收起浮窗 */
export function showVoiceInputComplete(_text, _duration = OVERLAY_COMPLETE_MS) {
  void hideVoiceInputOverlay()
}

/**
 * @param {import('./keyboard-shortcuts.js').ShortcutBinding} binding
 * @returns {string | null}
 */
export function bindingToGlobalShortcut(binding) {
  if (!binding || binding.disabled) return null
  const parts = []
  const mac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '')
  if (binding.ctrlOrMeta) {
    parts.push(mac ? 'Command' : 'Control')
  } else {
    if (binding.ctrl) parts.push('Control')
    if (binding.meta) parts.push(mac ? 'Command' : 'Super')
  }
  if (binding.alt) parts.push('Alt')
  if (binding.shift) parts.push('Shift')

  const code = String(binding.code || '').trim()
  const key = String(binding.key || '').trim()
  let keyPart = ''
  if (code.startsWith('Key') && code.length === 4) {
    keyPart = code.slice(3).toUpperCase()
  } else if (code.startsWith('Digit') && code.length === 6) {
    keyPart = code.slice(5)
  } else if (code === 'Space' || key === ' ') {
    keyPart = 'Space'
  } else if (key.length === 1) {
    keyPart = key.toUpperCase()
  } else if (code) {
    keyPart = code
  }
  if (!keyPart) return null
  parts.push(keyPart)
  return parts.join('+')
}

/**
 * @param {'idle' | 'recording' | 'processing' | 'running' | 'speaking'} state
 */
export async function setVoiceTrayState(state) {
  if (!isTauri) return
  const labels = {
    idle: `${TRAY_BASE} · 待命`,
    recording: `${TRAY_BASE} · 录音中…`,
    processing: `${TRAY_BASE} · 识别中…`,
    running: `${TRAY_BASE} · 执行中…`,
    speaking: `${TRAY_BASE} · 播报中…`,
  }
  const text = labels[state] || labels.idle
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('set_tray_tooltip', { text })
  } catch (e) {
    console.warn('[background-voice] tray tooltip', e)
  }
}

async function syncGlobalHotkey() {
  if (!isTauri) return
  const binding = getShortcutBinding('voicePushToTalk')
  const shortcut = bindingToGlobalShortcut(binding)
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('sync_voice_hotkey', { shortcut })
  } catch (e) {
    console.warn('[background-voice] sync hotkey', e)
  }
}

/** @param {{ silent?: boolean }} [opts] */
async function ensureSpeechReady(opts = {}) {
  const { isVolcengineAsrEnabled } = await import('./voice-asr-policy.js')
  const { isWebSpeechCaptureAvailable } = await import('./web-speech-capture.js')

  if (isVolcengineAsrEnabled()) {
    const { fetchSpeechConfigured } = await import('./speech-client.js')
    const ok = await fetchSpeechConfigured()
    if (ok) return true
    if (isWebSpeechCaptureAvailable()) {
      console.warn('[background-voice] Volcengine unavailable; Web Speech fallback')
      return true
    }
    if (!opts.silent) {
      const { toast } = await import('../components/toast.js')
      toast('请先在「设置 → 模型 → 语音」配置火山语音', 'warning')
      void setVoiceTrayState('idle')
    }
    return false
  }

  if (isWebSpeechCaptureAvailable()) return true
  if (!opts.silent) {
    const { toast } = await import('../components/toast.js')
    toast('当前环境不支持系统语音识别', 'warning')
    void setVoiceTrayState('idle')
  }
  return false
}

/** @type {boolean} */
let demoToastShown = false

/**
 * 创建并装配 PTT 控制器（策略模块）。
 * 将 voice-capture-service / bridge / 演示模式 / 确认语等依赖以钩子注入 voice-ptt.js。
 */
function initPttController() {
  if (pttController) return

  pttController = createPttController({
    // ── 录音接口 ──
    startCapture: async (opts = {}) => {
      beginVoicePartialSession()
      return startVoiceCapture({
        ...opts,
        onPartial: (text) => {
          updateVoicePartialText(text)
          opts.onPartial?.(text)
        },
      })
    },
    stopCapture: async () => {
      // Keep wake paused; sendText arms follow-up which resumes when done.
      // Empty transcript path resumes in onMicError / tray idle handlers below via resume.
      const result = await stopVoiceCapture({ keepWakePaused: true })
      endVoicePartialSession({ cancelled: false })
      return result
    },
    getPartialTranscript: () => getVoicePartialTranscript(),
    cancelCapture: () => {
      cancelVoiceCapture()
      endVoicePartialSession({ cancelled: true })
      void resumeWakeEarAfterContinuous()
    },
    isCaptureActive: () => isVoiceCaptureActive(),

    // ── 持续模式接口（叠加语义） ──
    isContinuousActive: () => continuousModeEnabled && isContinuousCaptureActive(),
    getContinuousTranscript: () => getContinuousTranscript(),
    resetContinuousTranscript: () => resetContinuousTranscript(),
    cancelContinuousAutoSend: () => continuousPolicy?.cancelAutoSend(),
    suppressContinuousTranscripts: (ms) => {
      const recorder = getActiveStreamingRecorder()
      if (recorder?.suppressTranscripts) recorder.suppressTranscripts(ms)
    },

    // ── 发送 ──
    sendText: async (text, opts) => {
      await handleVoiceCommandText(text, opts)
      // Continuous mode already keeps the mic open — don't stack a follow-up session.
      if (continuousModeEnabled) {
        void resumeWakeEarAfterContinuous()
        return
      }
      try {
        const { armVoiceFollowUpAfterSend } = await import('./voice-follow-up.js')
        armVoiceFollowUpAfterSend({
          sendText: (t) => handleVoiceCommandText(t, { global: true }),
          onTrayState: (s) => setVoiceTrayState(s),
          onPartial: (partial) => updateVoicePartialText(partial),
        })
      } catch (e) {
        console.warn('[background-voice] follow-up arm failed:', e?.message || e)
        void resumeWakeEarAfterContinuous()
      }
    },

    // ── 托盘状态 ──
    onTrayState: (state) => setVoiceTrayState(state),

    // ── 浮窗 ──
    showOverlay: () => showVoiceInputOverlay(),
    hideOverlay: () => hideVoiceInputOverlay(),

    // ── 演示模式 ──
    isDemoActive: () => isVoiceDemoActive(),
    startDemo: (opts) => startVoiceDemo(opts),
    stopDemo: () => stopVoiceDemo(),
    demoResult: () => demoTranscriptResult(),
    onDemoToast: async () => {
      if (demoToastShown) return
      demoToastShown = true
      const { toast } = await import('../components/toast.js')
      toast('演示模式：未检测到麦克风，仅预览动效', 'info')
    },

    // ── 确认语 ──
    startSimpleAck: async (cb) => {
      const { getVoiceReplyEnabled } = await import('./panel-settings.js')
      const { shouldArmVoiceReply } = await import('./voice-reply-mode.js')
      if (!shouldArmVoiceReply(getVoiceReplyEnabled())) return
      const { resetStreamingSpeechQueue } = await import('./speech-client.js')
      resetStreamingSpeechQueue()
      const { startVoiceSimpleAck } = await import('./voice-reply-speech.js')
      startVoiceSimpleAck(cb)
    },

    // ── TTS 停止（按下时打断当前播报） ──
    stopAllSpeech: async () => {
      const { stopAllAssistantSpeech } = await import('./speech-client.js')
      stopAllAssistantSpeech()
    },

    // ── 麦克风探测 ──
    probeMicrophone: async () => {
      const { probeMicrophoneAvailable } = await import('./speech-audio.js')
      return probeMicrophoneAvailable()
    },
    onMicAccessError: (e) => {
      // 动态导入避免循环依赖
      return import('./speech-audio.js').then(({ isMicrophoneAccessError }) =>
        isMicrophoneAccessError(e)
      )
    },
    onMicError: async (e) => {
      void resumeWakeEarAfterContinuous()
      const { toast } = await import('../components/toast.js')
      const raw = String(e?.message || e || '').trim()
      if (raw === PTT_SHORT_PRESS_HINT || raw.includes('按住语音键')) {
        toast(PTT_SHORT_PRESS_HINT, 'info')
        return
      }
      if (raw === '未识别到语音内容') {
        toast('未识别到语音内容，请按住说话后再试', 'warning')
        return
      }
      const { microphoneErrorMessage } = await import('./speech-audio.js')
      toast(microphoneErrorMessage(e), 'error')
    },

    // ── 开麦前就绪检查 ──
    ensureSpeechReady: () => ensureSpeechReady({ silent: true }),
    isSendReady: () => isVoiceSendHandlerReady(),
  })
}

/**
 * PTT 按下 — 转发给 voice-ptt.js 策略模块。
 */
async function onVoicePushDown() {
  try {
    const { cancelVoiceFollowUp } = await import('./voice-follow-up.js')
    cancelVoiceFollowUp()
  } catch {
    /* ignore */
  }
  await pttController?.pttStart()
}

/**
 * PTT 松手 — 异步队列化转发（串行化多次松手事件）。
 */
function queueVoicePushUp() {
  pttController?.queueVoicePushUp()
}

export async function initBackgroundVoice() {
  if (!isTauri || inited) return
  inited = true

  // 装配 PTT 控制器（策略模块）
  initPttController()

  const { listen } = await import('@tauri-apps/api/event')
  await listen('voice-push-down', () => {
    void onVoicePushDown()
  })
  await listen('voice-push-up', () => {
    queueVoicePushUp()
  })

  const onShortcutsChanged = () => {
    void syncGlobalHotkey()
  }
  window.addEventListener(KEYBOARD_SHORTCUTS_CHANGED, onShortcutsChanged)

  await syncGlobalHotkey()
  void setVoiceTrayState('idle')

  // Auto-start wake word: local KWS if bundled, else Web Speech fallback.
  try {
    if (getPanelSetting('voiceWakeEnabled') !== false) {
      void toggleWakeWord(true)
    }
  } catch {
    // Settings not ready yet — wake word can be enabled later via toggle
  }
}

// ─── Wake word ───

/** @type {'kws' | 'webspeech' | null} */
let wakeWordBackend = null

/**
 * Toggle wake word detection (「小V小V」).
 * Prefer local sherpa-onnx KWS; if WASM missing, fall back to Web Speech API.
 * On hit → auto-starts continuous voice mode.
 * @param {boolean} [enable] true=on, false=off, undefined=toggle
 * @returns {Promise<boolean>} current state after toggle
 */
export async function toggleWakeWord(enable) {
  const target = enable !== undefined ? enable : !wakeWordEnabled
  if (target === wakeWordEnabled) return wakeWordEnabled

  if (target) {
    try {
      const { isKwsBundleAvailable, startEar } = await import('./wake-word.js')
      if (await isKwsBundleAvailable()) {
        const ok = await startEar()
        if (ok) {
          wakeWordEnabled = true
          wakeWordBackend = 'kws'
          window.addEventListener('wake-word-hit', onWakeWordHit)
          console.log('[background-voice] Wake word ear ON (local KWS · 小V小V)')
          return true
        }
      } else {
        console.info(
          '[background-voice] KWS WASM missing — trying Web Speech wake (say 小V小V). Optional: node scripts/download-kws-model.js',
        )
      }
    } catch (e) {
      console.warn('[background-voice] KWS wake start failed:', e?.message)
    }

    try {
      const { isWebSpeechWakeAvailable, startWebSpeechEar } = await import(
        './wake-word-webspeech.js'
      )
      if (!isWebSpeechWakeAvailable()) {
        console.warn('[background-voice] Wake word unavailable (no KWS WASM, no Web Speech)')
        return false
      }
      const ok = await startWebSpeechEar()
      if (ok) {
        wakeWordEnabled = true
        wakeWordBackend = 'webspeech'
        window.addEventListener('wake-word-hit', onWakeWordHit)
        console.log('[background-voice] Wake word ear ON (Web Speech · 小V小V)')
        return true
      }
    } catch (e) {
      console.warn('[background-voice] Web Speech wake start failed:', e?.message)
    }
    return false
  }

  try {
    if (wakeWordBackend === 'webspeech') {
      const { stopWebSpeechEar } = await import('./wake-word-webspeech.js')
      stopWebSpeechEar()
    } else {
      const { stopEar } = await import('./wake-word.js')
      stopEar()
    }
  } catch (e) {
    /* ignore */
  }
  wakeWordEnabled = false
  wakeWordBackend = null
  window.removeEventListener('wake-word-hit', onWakeWordHit)
  console.log('[background-voice] Wake word ear OFF')
  return false
}

export function isWakeWordActive() {
  return wakeWordEnabled
}

async function openXiaomiForWake() {
  setPreferXiaomiVoice(true)
  try {
    const { openGlobalAssistant } = await import('../components/global-assistant/index.js')
    openGlobalAssistant()
  } catch (e) {
    console.warn('[background-voice] open global assistant failed:', e?.message || e)
  }
}

async function onWakeWordHit() {
  if (!wakeWordEnabled) return
  // Re-entrancy guard: Web Speech may fire multiple hits while we start listening.
  if (onWakeWordHit._busy) return
  onWakeWordHit._busy = true
  console.log('[background-voice] Wake word hit! Opening 小V...')

  try {
    await openXiaomiForWake()
    // Re-wake while speaking / listening → interrupt TTS and start a fresh turn.
    try {
      const { stopAllAssistantSpeech } = await import('./speech-client.js')
      stopAllAssistantSpeech()
      notifyTTSStopped()
    } catch {
      /* ignore */
    }
    try {
      const { cancelVoiceFollowUp } = await import('./voice-follow-up.js')
      cancelVoiceFollowUp()
    } catch {
      /* ignore */
    }
    await pauseWakeEarForContinuous()
    // Genie-style: chime + 「在呢」 before opening the command mic.
    await acknowledgeWakeHit()

    // Web Speech wake path: keep using Web Speech for the command.
    // Switching to Volcengine streaming right after SpeechRecognition held the mic
    // causes silent/stalled ASR (watchdog reconnect loop).
    if (wakeWordBackend === 'webspeech') {
      await runWebSpeechCommandTurn()
      return
    }

    // Local KWS wake → prefer continuous Volcengine when enabled; else one-shot Web Speech.
    if (!continuousModeEnabled) {
      const { isVolcengineAsrEnabled } = await import('./voice-asr-policy.js')
      if (!isVolcengineAsrEnabled()) {
        await runWebSpeechCommandTurn()
        return
      }
      await new Promise((r) => setTimeout(r, 350))
      await toggleContinuousMode({ onTrayState: (s) => setVoiceTrayState(s) })
    }
  } finally {
    onWakeWordHit._busy = false
  }
}

/** Toast + earcon + short spoken ack; waits until speech ends so ASR won't hear itself. */
async function acknowledgeWakeHit() {
  try {
    const { toast } = await import('../components/toast.js')
    toast('小V在听，请说…', 'info')
  } catch {
    /* ignore */
  }
  void setVoiceTrayState('speaking')
  try {
    const { playWakeListeningAck } = await import('./wake-ack.js')
    await playWakeListeningAck()
  } catch (e) {
    console.warn('[background-voice] wake ack failed:', e?.message || e)
  }
}

/** @type {boolean} */
onWakeWordHit._busy = false

async function runWebSpeechCommandTurn() {
  try {
    const { listenOnceForCommand } = await import('./wake-word-webspeech.js')
    // Brief gap after wake ack / SpeechRecognition teardown before command session.
    await new Promise((r) => setTimeout(r, 350))

    void setVoiceTrayState('recording')
    const text = await listenOnceForCommand({
      timeoutMs: 14000,
      onPartial: (partial) => {
        updateVoicePartialText(partial)
      },
    })
    const cleaned = String(text || '').trim()
    if (!cleaned) {
      const { toast } = await import('../components/toast.js')
      toast('没听清，再说一次「小V小V」', 'warning')
      void setVoiceTrayState('idle')
      return
    }

    void setVoiceTrayState('processing')
    updateVoicePartialText('')
    const result = await handleVoiceCommandText(cleaned, { global: true, xiaomi: true })
    if (result === 'paused' || result === 'empty') return
    // 「停止播报」后仍可继续说下一句
    if (result === 'tts_stopped') {
      // fall through to follow-up listen window
    }

    // Same follow-up window as Alt+X / mic: after TTS, keep listening.
    const { runVoiceFollowUpRounds } = await import('./voice-follow-up.js')
    await runVoiceFollowUpRounds({
      sendText: (t) => handleVoiceCommandText(t, { global: true, xiaomi: true }),
      onTrayState: (s) => setVoiceTrayState(s),
      onPartial: (partial) => updateVoicePartialText(partial),
      isActive: () => wakeWordEnabled,
      // Wake ear already paused; outer finally resumes.
      manageWakeEar: false,
    })
  } catch (e) {
    console.warn('[background-voice] web speech command failed:', e?.message || e)
    const { toast: toastErr } = await import('../components/toast.js')
    toastErr(String(e?.message || e || '语音听取失败'), 'error')
    void setVoiceTrayState('idle')
  } finally {
    updateVoicePartialText('')
    setPreferXiaomiVoice(false)
    // Conversation window closed → back to wake-word only.
    await new Promise((r) => setTimeout(r, 400))
    await resumeWakeEarAfterContinuous()
    void setVoiceTrayState('idle')
  }
}

/** Exported for voice-follow-up (Alt+X / mic) to free the wake ear while listening. */
export async function pauseWakeEarForVoiceSession() {
  await pauseWakeEarForContinuous()
}

export async function resumeWakeEarAfterVoiceSession() {
  await resumeWakeEarAfterContinuous()
}

async function pauseWakeEarForContinuous() {
  if (!wakeWordEnabled) return
  try {
    if (wakeWordBackend === 'webspeech') {
      const { stopWebSpeechEar } = await import('./wake-word-webspeech.js')
      stopWebSpeechEar()
    } else if (wakeWordBackend === 'kws') {
      const { stopEar } = await import('./wake-word.js')
      stopEar()
    }
  } catch {
    /* ignore */
  }
}

async function resumeWakeEarAfterContinuous() {
  if (!wakeWordEnabled) return
  try {
    if (wakeWordBackend === 'webspeech') {
      const { startWebSpeechEar } = await import('./wake-word-webspeech.js')
      await startWebSpeechEar()
    } else if (wakeWordBackend === 'kws') {
      const { startEar } = await import('./wake-word.js')
      await startEar()
    }
  } catch (e) {
    console.warn('[background-voice] resume wake ear failed:', e?.message)
  }
}

// ─── 持续监听模式 ───

/** @type {ReturnType<typeof createContinuousPolicy> | null} */
let continuousPolicy = null
/** @type {boolean} */
let continuousModeEnabled = false
/** @type {((state: 'idle' | 'recording' | 'processing' | 'running' | 'speaking') => void) | null} */
let continuousTrayStateCb = null

export function isContinuousModeActive() {
  return continuousModeEnabled && isContinuousCaptureActive()
}

/**
 * Toggle continuous listening mode on/off.
 * When ON: mic stays open, ASR streams, auto-send on silence, barge-in during TTS.
 * When OFF: stop continuous capture, teardown policy.
 * @param {{ onTrayState?: (state: string) => void }} [opts]
 */
export async function toggleContinuousMode(opts = {}) {
  continuousTrayStateCb = opts.onTrayState || null

  if (continuousModeEnabled) {
    // Turn OFF
    continuousModeEnabled = false
    continuousPolicy?.reset()
    continuousPolicy = null
    try {
      const { clearTTSNotifyCallbacks } = await import('./voice-reply-speech.js')
      clearTTSNotifyCallbacks()
    } catch {
      /* ignore */
    }
    await stopContinuousCapture()
    setPreferXiaomiVoice(false)
    void setVoiceTrayState('idle')
    void resumeWakeEarAfterContinuous()
    return false
  }

  // Turn ON
  const { fetchSpeechConfigured } = await import('./speech-client.js')
  const ok = await fetchSpeechConfigured()
  if (!ok) {
    const { toast } = await import('../components/toast.js')
    toast('请先在「设置 → 模型 → 语音」配置火山语音', 'warning')
    return false
  }

  const sendReady = isVoiceSendHandlerReady() || isXiaomiVoiceSendHandlerReady()
  if (!sendReady) {
    const { toast } = await import('../components/toast.js')
    toast('小V尚未就绪，请稍后再试', 'warning')
    return false
  }

  continuousModeEnabled = true

  // Free wake-word mic while continuous ASR owns capture.
  await pauseWakeEarForContinuous()

  // Wire TTS start/stop → barge-in + suspend/resume ASR during playback.
  try {
    const { setTTSNotifyCallbacks } = await import('./voice-reply-speech.js')
    setTTSNotifyCallbacks({
      onStart: () => notifyTTSStarted(),
      onStop: () => notifyTTSStopped(),
    })
  } catch (e) {
    console.warn('[background-voice] TTS notify wire failed:', e?.message || e)
  }

  // Create the continuous policy
  continuousPolicy = createContinuousPolicy({
    getText: () => getContinuousTranscript(),
    sendText: (text) => {
      resetContinuousTranscript()
      void handleVoiceCommandText(text, { global: true }).catch(() => {
        void setVoiceTrayState('idle')
      })
    },
    duckTTS: () => {
      import('./speech-client.js').then(({ duckTTS }) => duckTTS())
    },
    unduckTTS: () => {
      import('./speech-client.js').then(({ unduckTTS }) => unduckTTS())
    },
    stopTTS: () => {
      // Barge-in: stop playback; idle hook / notifyTTSStopped resumes ASR.
      void import('./speech-client.js').then(({ stopTTS }) => stopTTS())
      const recorder = getContinuousRecorder()
      if (recorder?.suspendedByTTS) {
        void recorder.resumeFromTTS(true).catch(() => {})
      }
    },
    onProcessing: () => {
      void setVoiceTrayState('processing')
    },
    // PTT 门控：PTT 按住期间禁用持续模式的自动发送
    isPttHolding: () => pttController?.isPttHolding() ?? false,
  })

  try {
    await startContinuousCapture({
      onPartial: (text) => {
        // Push partial text to ChatComposer for real-time display
        updateVoicePartialText(text)
        // Feed transcript to policy for auto-send timing
        continuousPolicy?.onTranscript()
        void setVoiceTrayState('recording')
      },
      onFinal: () => {
        continuousPolicy?.onTranscript()
      },
      onFrame: (vol) => {
        // Feed mic volume to policy for barge-in detection
        continuousPolicy?.onFrame(vol)
      },
      onError: (err) => {
        console.warn('[continuous] error', err)
      },
    })
    void setVoiceTrayState('idle')
    return true
  } catch (e) {
    continuousModeEnabled = false
    continuousPolicy = null
    try {
      const { clearTTSNotifyCallbacks } = await import('./voice-reply-speech.js')
      clearTTSNotifyCallbacks()
    } catch {
      /* ignore */
    }
    void resumeWakeEarAfterContinuous()
    const { toast } = await import('../components/toast.js')
    toast(String((e && e.message) || e || '持续监听启动失败'), 'error')
    return false
  }
}

/**
 * Notify continuous policy that TTS playback has started.
 * Called when AI begins speaking.
 * 挂起持续监听的 ASR（只断 WS 不断 mic，开启打断预缓冲）。
 */
export function notifyTTSStarted() {
  const recorder = getContinuousRecorder()
  if (recorder?.recording || recorder?.suspendedByTTS) {
    recorder?.suspendForTTS()
  }
  continuousPolicy?.onTTSStart()
}

/**
 * Notify continuous policy that TTS playback has stopped.
 * Called when AI finishes speaking or TTS is stopped.
 * 从 TTS 挂起恢复 ASR（重连 WS + flush 打断预缓冲）。
 */
export function notifyTTSStopped() {
  const recorder = getContinuousRecorder()
  if (recorder?.suspendedByTTS) {
    void recorder?.resumeFromTTS(false).catch(() => {})
  }
  continuousPolicy?.onTTSStop()
}

/**
 * Whether continuous capture is actively listening for user speech
 * (wake-word ear alone does not count). Follow-up: import isVoiceFollowUpActive.
 */
export function isConversationListeningActive() {
  return !!(continuousModeEnabled && isContinuousCaptureActive())
}

/**
 * Route a recognized voice command: stop-listen / stop-TTS / normal send.
 * @param {string} text
 * @param {{ global?: boolean, xiaomi?: boolean }} [opts]
 * @returns {Promise<'paused' | 'tts_stopped' | 'sent' | 'empty'>}
 */
export async function handleVoiceCommandText(text, opts = {}) {
  const cleaned = String(text || '').trim()
  if (!cleaned) return 'empty'

  const { isStopListenCommand, isStopTtsOnlyCommand } = await import('./voice-listen-control.js')
  if (isStopListenCommand(cleaned)) {
    await pauseConversationListening({ reason: 'voice' })
    return 'paused'
  }
  if (isStopTtsOnlyCommand(cleaned)) {
    const { stopAllAssistantSpeech } = await import('./speech-client.js')
    stopAllAssistantSpeech()
    notifyTTSStopped()
    try {
      const { toast } = await import('../components/toast.js')
      toast('已停止播报', 'info')
    } catch {
      /* ignore */
    }
    return 'tts_stopped'
  }

  // Speaking over the assistant → interrupt TTS before sending the new turn.
  try {
    const { isSpeechPlaybackBusy, stopAllAssistantSpeech } = await import('./speech-client.js')
    if (isSpeechPlaybackBusy()) {
      stopAllAssistantSpeech()
      notifyTTSStopped()
    }
  } catch {
    /* ignore */
  }

  await sendVoiceTranscript(cleaned, opts)
  return 'sent'
}

/**
 * Pause conversation listening (continuous / follow-up). Wake-word ear stays on
 * so the user can say 「小V小V」 to resume.
 * @param {{ reason?: 'voice' | 'button' | 'reset', silent?: boolean }} [opts]
 */
export async function pauseConversationListening(opts = {}) {
  const silent = !!opts.silent

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
    const { stopAllAssistantSpeech } = await import('./speech-client.js')
    stopAllAssistantSpeech()
  } catch {
    /* ignore */
  }

  if (continuousModeEnabled) {
    continuousModeEnabled = false
    continuousPolicy?.reset()
    continuousPolicy = null
    try {
      const { clearTTSNotifyCallbacks } = await import('./voice-reply-speech.js')
      clearTTSNotifyCallbacks()
    } catch {
      /* ignore */
    }
    await stopContinuousCapture()
  }

  setPreferXiaomiVoice(false)
  updateVoicePartialText('')
  await resumeWakeEarAfterContinuous()
  void setVoiceTrayState('idle')

  if (!silent) {
    try {
      const { toast } = await import('../components/toast.js')
      toast('已暂停监听，再说「小V小V」继续', 'info')
    } catch {
      /* ignore */
    }
  }
}

/**
 * Stop TTS playback only (keep listening).
 */
export async function stopAssistantVoicePlayback() {
  try {
    const { stopAllAssistantSpeech } = await import('./speech-client.js')
    stopAllAssistantSpeech()
  } catch {
    /* ignore */
  }
  notifyTTSStopped()
}

export function resetAllVoiceState() {
  pttController?.reset()
  stopVoiceDemo()
  void hideVoiceInputOverlay()
  cancelVoiceCapture()
  try {
    void import('./voice-follow-up.js').then(({ cancelVoiceFollowUp }) => cancelVoiceFollowUp())
  } catch {
    /* ignore */
  }
  // Also stop continuous mode if active
  if (continuousModeEnabled) {
    continuousModeEnabled = false
    continuousPolicy?.reset()
    continuousPolicy = null
    try {
      void import('./voice-reply-speech.js').then(({ clearTTSNotifyCallbacks }) =>
        clearTTSNotifyCallbacks(),
      )
    } catch {
      /* ignore */
    }
    void stopContinuousCapture()
  }
  void setVoiceTrayState('idle')
  console.log('[background-voice] 所有语音状态已强制重置')
}

export function teardownBackgroundVoiceCapture() {
  pttController?.reset()
  stopVoiceDemo()
  cancelVoiceCapture()
  if (continuousModeEnabled) {
    continuousModeEnabled = false
    continuousPolicy?.reset()
    continuousPolicy = null
    void stopContinuousCapture()
  }
}
