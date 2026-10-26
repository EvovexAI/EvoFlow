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

/** 语音舞台 / 全屏 UI 订阅：与 Tauri 托盘文案同源 */
export const VOICE_TRAY_STATE_EVENT = 'evopanel:voice-tray-state'

/**
 * @param {'idle' | 'recording' | 'processing' | 'running' | 'speaking'} state
 */
export async function setVoiceTrayState(state) {
  const next = String(state || 'idle')
  try {
    window.dispatchEvent(
      new CustomEvent(VOICE_TRAY_STATE_EVENT, { detail: { state: next } }),
    )
  } catch {
    /* ignore */
  }
  if (!isTauri) return
  const labels = {
    idle: `${TRAY_BASE} · 待命`,
    recording: `${TRAY_BASE} · 录音中…`,
    processing: `${TRAY_BASE} · 识别中…`,
    running: `${TRAY_BASE} · 执行中…`,
    speaking: `${TRAY_BASE} · 播报中…`,
  }
  const text = labels[next] || labels.idle
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
      const { shouldXiaomiVoiceReply } = await import('./xiaomi-voice-defaults.js')
      if (!shouldXiaomiVoiceReply(shouldArmVoiceReply(getVoiceReplyEnabled()))) return
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
  // 统一走 openXiaomiRightStage：ensure session + 语音全屏 + 默认开语音播报
  try {
    const { ensureXiaomiVoiceReplyOn } = await import('./xiaomi-voice-defaults.js')
    await ensureXiaomiVoiceReplyOn()
  } catch (e) {
    console.warn('[background-voice] enable voice reply failed:', e?.message || e)
  }
  try {
    const { openXiaomiRightStage } = await import('./right-stage/open-right-stage-xiaomi.js')
    // 唤醒：只进左侧语音域，不弹右侧流式文字面板（对话以左栏实时区为主）
    await openXiaomiRightStage({
      navigateToChat: true,
      voiceMode: true,
      showRightStage: false,
    })
    return
  } catch (e) {
    console.warn('[background-voice] open xiaomi stage failed:', e?.message || e)
  }
  try {
    const { enterXwVoiceMode } = await import('./xw-voice-mode.js')
    enterXwVoiceMode({ expandRightStage: false })
    return
  } catch (e) {
    console.warn('[background-voice] enter voice stage failed:', e?.message || e)
  }
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

    // 是否能走常开连续模式（火山流式 ASR 已配置）
    let volcReady = false
    try {
      const { fetchSpeechConfigured, speechStreamingAsrCached } = await import('./speech-client.js')
      volcReady = (await fetchSpeechConfigured()) === true || speechStreamingAsrCached() === true
    } catch {
      volcReady = false
    }

    if (volcReady && !continuousModeEnabled) {
      // 先口头「在呢」再开麦：用户明确知道已唤醒；ack 播完再采音，避免自听。
      await acknowledgeWakeHit({ spoken: true })
      await new Promise((r) => setTimeout(r, 200))
      const ok = await toggleContinuousMode({ onTrayState: (s) => setVoiceTrayState(s) })
      if (ok) return
      // 开启失败（未配置/未就绪）→ 回退单轮命令；runWebSpeechCommandTurn 的 finally 会恢复唤醒耳。
      console.warn('[background-voice] continuous start failed — fallback to one-shot command')
    } else if (!volcReady) {
      await acknowledgeWakeHit({ spoken: true })
    } else {
      // 已在连续模式：再喊一次仍口头回应，并拉回聆听态。
      await acknowledgeWakeHit({ spoken: true })
      void setVoiceTrayState('recording')
      return
    }

    // 单轮命令路径（Web Speech；连续模式开启失败或火山不可用时）。
    await runWebSpeechCommandTurn()
  } finally {
    onWakeWordHit._busy = false
  }
}

/**
 * Toast + earcon + short spoken ack; waits until speech ends so ASR won't hear itself.
 * @param {{ spoken?: boolean }} [opts] spoken=false 时只播 chime（连续模式路径，快）
 */
/** 最近一次唤醒口头 ack 时间；用于跳过 send 后再播一遍确认语 */
let _lastWakeSpokenAckAt = 0

export function wasWakeSpokenAckRecent(withinMs = 5000) {
  return _lastWakeSpokenAckAt > 0 && Date.now() - _lastWakeSpokenAckAt < withinMs
}

async function acknowledgeWakeHit(opts = {}) {
  const spoken = opts.spoken !== false
  try {
    const { toast } = await import('../components/toast.js')
    toast(spoken ? '小V在听，请说…' : '小V在听', 'info')
  } catch {
    /* ignore */
  }
  void setVoiceTrayState('speaking')
  try {
    if (spoken) {
      const { playWakeListeningAck } = await import('./wake-ack.js')
      await playWakeListeningAck()
      _lastWakeSpokenAckAt = Date.now()
    } else {
      const { playWakeChime } = await import('./wake-ack.js')
      await playWakeChime()
    }
  } catch (e) {
    console.warn('[background-voice] wake ack failed:', e?.message || e)
  } finally {
    // ack 结束：若已在常听则回「聆听中」，否则先 idle，等 continuous 启动再 recording
    if (continuousModeEnabled && isContinuousCaptureActive()) {
      void setVoiceTrayState('recording')
    }
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
/** 常听空闲：长时间无人说话 → 播「先退下了」并关麦 */
/** @type {ReturnType<typeof setTimeout> | null} */
let _continuousIdleTimer = null
/** 正在播退下语，避免空闲计时重入 */
let _continuousFarewellBusy = false
/** continuous stopTTS 日志节流 */
let _continuousLastStopTtsAt = 0

/** 默认 20s；可用 localStorage `evoflow-voice-idle-farewell-ms` 覆盖（≥10000） */
function _continuousIdleFarewellMs() {
  try {
    const v = parseInt(localStorage.getItem('evoflow-voice-idle-farewell-ms') || '', 10)
    if (Number.isFinite(v) && v >= 10000) return v
  } catch {
    /* ignore */
  }
  return 20000
}

function _clearContinuousIdleTimer() {
  if (_continuousIdleTimer) {
    clearTimeout(_continuousIdleTimer)
    _continuousIdleTimer = null
  }
}

function _armContinuousIdleTimer() {
  _clearContinuousIdleTimer()
  if (!continuousModeEnabled || _continuousFarewellBusy) return
  const ms = _continuousIdleFarewellMs()
  _continuousIdleTimer = setTimeout(() => {
    _continuousIdleTimer = null
    void _runContinuousIdleFarewell()
  }, ms)
}

/**
 * 空闲退下：播固定音效 → 关闭常听（唤醒耳恢复）。
 */
async function _runContinuousIdleFarewell() {
  if (!continuousModeEnabled || _continuousFarewellBusy) return
  _continuousFarewellBusy = true
  _clearContinuousIdleTimer()
  try {
    void setVoiceTrayState('speaking')
    try {
      const { toast } = await import('../components/toast.js')
      toast('小V先退下了', 'info')
    } catch {
      /* ignore */
    }
    notifyTTSStarted()
    try {
      const { playFixedVoiceSfx, VOICE_FAREWELL_LINE } = await import('./voice-fixed-sfx.js')
      await playFixedVoiceSfx(VOICE_FAREWELL_LINE)
    } catch (e) {
      console.warn('[background-voice] idle farewell failed:', e?.message || e)
    }
  } finally {
    try {
      // 关掉常听并恢复唤醒耳（勿走 notifyTTSStopped，否则会重新 arm 空闲计时）
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
        setPreferXiaomiVoice(false)
        void setVoiceTrayState('idle')
        void resumeWakeEarAfterContinuous()
      }
    } catch (e) {
      console.warn('[background-voice] idle farewell stop failed:', e?.message || e)
    }
    _continuousFarewellBusy = false
  }
}

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
    _clearContinuousIdleTimer()
    continuousModeEnabled = false
    continuousPolicy?.reset()
    continuousPolicy = null
    try {
      const { clearTTSNotifyCallbacks } = await import('./voice-reply-speech.js')
      clearTTSNotifyCallbacks()
    } catch {
      /* ignore */
    }
    try {
      const { stopXiaomiFrameSession } = await import('./xiaomi-voice/index.js')
      stopXiaomiFrameSession()
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

  // 预热「在呢 / 先退下了」等固定句（IndexedDB 复用，不每次打 TTS）
  try {
    const { prefetchFixedVoiceSfxLines } = await import('./voice-fixed-sfx.js')
    prefetchFixedVoiceSfxLines()
  } catch {
    /* ignore */
  }

  // Pipecat：预连 Frame session（只占 WS 做分句 TTS，麦仍归 continuous ASR）
  try {
    const { connectXiaomiFrameSession, isXiaomiFrameSessionActive } = await import(
      './xiaomi-voice/index.js',
    )
    if (!isXiaomiFrameSessionActive()) {
      void connectXiaomiFrameSession().then((ws) => {
        if (ws) console.info('[background-voice] Frame session ready for continuous TTS')
      })
    }
  } catch (e) {
    console.warn('[background-voice] Frame session prefetch failed:', e?.message || e)
  }

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
      _clearContinuousIdleTimer() // 用户已开口，等 AI 说完再重新计空闲
      void handleVoiceCommandText(text, { global: true })
        .then(() => {
          // 本轮若无 TTS（播报关/短答无声），仍要重新挂空闲计时
          window.setTimeout(() => {
            if (!continuousModeEnabled || _continuousFarewellBusy) return
            void import('./speech-client.js')
              .then(({ isAssistantSpeaking, isSpeechPlaybackBusy }) => {
                if (isAssistantSpeaking() || isSpeechPlaybackBusy()) return
                _armContinuousIdleTimer()
              })
              .catch(() => _armContinuousIdleTimer())
          }, 12000)
        })
        .catch(() => {
          void setVoiceTrayState('idle')
          _armContinuousIdleTimer()
        })
    },
    duckTTS: () => {
      import('./speech-client.js').then(({ duckTTS }) => duckTTS())
    },
    unduckTTS: () => {
      import('./speech-client.js').then(({ unduckTTS }) => unduckTTS())
    },
    stopTTS: () => {
      // Barge-in：停播。正文已走 Frame，必须 barge Frame；legacy stopTTS 只清本地 Audio。
      const now = Date.now()
      if (!_continuousLastStopTtsAt || now - _continuousLastStopTtsAt > 400) {
        _continuousLastStopTtsAt = now
        void import('./xiaomi-voice/voice-file-log.js')
          .then(({ voiceFeLog }) =>
            voiceFeLog('打断', 'continuous 判定用户开口，停止 TTS（Frame barge + legacy pause）'),
          )
          .catch(() => {})
        void import('./xiaomi-voice/index.js')
          .then(({ bargeInXiaomiFrame, isXiaomiFrameSessionActive }) => {
            if (isXiaomiFrameSessionActive()) {
              bargeInXiaomiFrame({ reason: 'continuous-barge-in' })
            }
          })
          .catch(() => {})
      }
      void import('./speech-client.js').then(({ stopTTS }) => stopTTS())
      const recorder = getContinuousRecorder()
      if (recorder?.suspendedByTTS) {
        void recorder.resumeFromTTS(true).catch(() => {})
      }
    },
    onProcessing: () => {
      _clearContinuousIdleTimer()
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
        _armContinuousIdleTimer() // 有人说话 → 重置空闲
        void setVoiceTrayState('recording')
      },
      onFinal: () => {
        // 先刷转写计时（若 final 带来新文本则回静默计时），再挂快发：
        // 火山 final 是强"说完了"信号 → 400ms 宽限后发（期间来新转写会被取消）。
        continuousPolicy?.onTranscript()
        continuousPolicy?.onFinal()
        _armContinuousIdleTimer()
      },
      onFrame: (vol) => {
        // Feed mic volume to policy for barge-in detection
        continuousPolicy?.onFrame(vol)
      },
      onError: (err) => {
        console.warn('[continuous] error', err)
      },
    })
    // 常开聆听：启动后保持「录音中」，让语音舞台持续显示「正在聆听」
    void setVoiceTrayState('recording')
    _armContinuousIdleTimer()
    return true
  } catch (e) {
    _clearContinuousIdleTimer()
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
  _clearContinuousIdleTimer() // AI 说话期间不计空闲
  const recorder = getContinuousRecorder()
  if (recorder?.recording || recorder?.suspendedByTTS) {
    recorder?.suspendForTTS()
  }
  continuousPolicy?.onTTSStart()
  if (continuousModeEnabled) void setVoiceTrayState('speaking')
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
  // 播报结束 → 回到持续聆听态（起止可感知），并重新计空闲退下
  if (continuousModeEnabled && isContinuousCaptureActive() && !_continuousFarewellBusy) {
    void setVoiceTrayState('recording')
    _armContinuousIdleTimer()
  }
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

  // Speaking over the assistant → 停当前播放并清空队列，再发新一轮。
  // 用 stopAll；但 continuous 回声误触应走 stopTTS（保留队列），此处是确认要发新 turn。
  try {
    const { isSpeechPlaybackBusy, stopAllAssistantSpeech } = await import('./speech-client.js')
    if (isSpeechPlaybackBusy()) {
      stopAllAssistantSpeech({ reason: 'voice-command-new-turn' })
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
    _clearContinuousIdleTimer()
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
  _clearContinuousIdleTimer()
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
  _clearContinuousIdleTimer()
  if (continuousModeEnabled) {
    continuousModeEnabled = false
    continuousPolicy?.reset()
    continuousPolicy = null
    void stopContinuousCapture()
  }
}

/**
 * 小V 语音舞台 PTT 入口：按下=开麦（播报中按下自动打断），松手=识别并发送。
 */
export async function startVoicePtt() {
  await onVoicePushDown()
}

export function stopVoicePtt() {
  queueVoicePushUp()
}
