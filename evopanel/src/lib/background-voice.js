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
  clearPendingVoiceSend,
  endVoicePartialSession,
  isVoiceSendBusy,
  isVoiceSendHandlerReady,
  isXiaomiVoiceSendHandlerReady,
  sendVoiceTranscript,
  isPreferXiaomiVoice,
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
  // Frame 本地播报中：禁止 continuous 把 UI 打回「聆听/空闲」
  try {
    const { isXiaomiFramePlaying, isXiaomiFramePipelineActive } = await import(
      './xiaomi-voice/index.js',
    )
    if (
      isXiaomiFramePipelineActive?.() &&
      isXiaomiFramePlaying?.() &&
      (next === 'recording' || next === 'idle')
    ) {
      return
    }
  } catch {
    /* ignore */
  }
  try {
    const { noteVoiceUiState } = await import('./xiaomi-voice/voice-file-log.js')
    noteVoiceUiState(next, { source: '托盘' })
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(
      new CustomEvent(VOICE_TRAY_STATE_EVENT, { detail: { state: next } }),
    )
  } catch {
    /* ignore */
  }
  if (!isTauri) return
  const labels = {
    idle: `${TRAY_BASE} · 聆听`,
    recording: `${TRAY_BASE} · 聆听`,
    processing: `${TRAY_BASE} · 思考`,
    running: `${TRAY_BASE} · 思考`,
    speaking: `${TRAY_BASE} · 播报`,
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
      stopAllAssistantSpeech({ reason: 'user-stop-tts', forceFrame: true })
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

  // Frame MSE 播报也算「忙碌」，避免 continuous 空闲计时在 AI 还在说时开火
  try {
    const { registerSpeechBusyExtra } = await import('./speech-client.js')
    const { isXiaomiFramePlaying } = await import('./xiaomi-voice/session-client.js')
    registerSpeechBusyExtra(() => !!isXiaomiFramePlaying?.())
  } catch {
    /* ignore */
  }

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

/** @type {'native-kws' | 'kws' | 'webspeech' | null} */
let wakeWordBackend = null

/**
 * Toggle wake word detection (「小V小V」).
 * Prefer native sidecar KWS → browser WASM → Web Speech.
 * On hit → open 手屏 (语音全屏) via openXiaomiForWake.
 * @param {boolean} [enable] true=on, false=off, undefined=toggle
 * @returns {Promise<boolean>} current state after toggle
 */
export async function toggleWakeWord(enable) {
  const target = enable !== undefined ? enable : !wakeWordEnabled
  if (target === wakeWordEnabled) return wakeWordEnabled

  if (target) {
    try {
      const { isNativeKwsAvailable, startNativeEar } = await import('./wake-word-native.js')
      if (await isNativeKwsAvailable()) {
        const ok = await startNativeEar()
        if (ok) {
          wakeWordEnabled = true
          wakeWordBackend = 'native-kws'
          window.addEventListener('wake-word-hit', onWakeWordHit)
          console.log('[background-voice] Wake word ear ON (native KWS sidecar · 小V小V)')
          return true
        }
      }
    } catch (e) {
      console.warn('[background-voice] native KWS wake start failed:', e?.message)
    }

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
          '[background-voice] KWS WASM missing/unusable — trying Web Speech wake (say 小V小V)',
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
        console.warn(
          '[background-voice] Wake word unavailable (no native KWS, no WASM, no Web Speech)',
        )
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
    } else if (wakeWordBackend === 'native-kws') {
      const { stopNativeEar } = await import('./wake-word-native.js')
      await stopNativeEar()
    } else if (wakeWordBackend === 'kws') {
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

async function focusMainWindowForWake() {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const win = getCurrentWindow()
    await win.unminimize().catch(() => {})
    await win.show().catch(() => {})
    await win.setFocus().catch(() => {})
  } catch {
    /* web / non-tauri */
  }
}

async function openXiaomiForWake() {
  setPreferXiaomiVoice(true)
  // 唤醒热路径：先弹手屏（语音全屏）开麦，ensure 放后台。
  void import('./xiaomi-voice/voice-file-log.js')
    .then((m) => m.noteWakeMilestone?.('prefer_set_ensure_bg'))
    .catch(() => {})
  void import('./xiaomi-voice-defaults.js')
    .then((m) => m.ensureXiaomiVoiceReplyOn())
    .catch((e) => console.warn('[background-voice] enable voice reply failed:', e?.message || e))
  await focusMainWindowForWake()
  try {
    const { openXiaomiRightStage } = await import('./right-stage/open-right-stage-xiaomi.js')
    // 唤醒：左侧手屏语音域（xw-voice-mode），不弹右侧流式文字面板
    await openXiaomiRightStage({
      navigateToChat: true,
      voiceMode: true,
      showRightStage: false,
    })
    try {
      const { isXwVoiceMode } = await import('./xw-voice-mode.js')
      const xw = isXwVoiceMode()
      console.log('[background-voice] wake open done, xwVoice=', xw)
      void import('./xiaomi-voice/voice-file-log.js')
        .then((m) => m.noteWakeMilestone?.('open_panel_done', { xwVoice: xw }))
        .catch(() => {})
    } catch {
      /* ignore */
    }
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

async function onWakeWordHit(ev) {
  if (!wakeWordEnabled) {
    void import('./xiaomi-voice/voice-file-log.js')
      .then(({ voiceFeLog }) => voiceFeLog('唤醒', '收到 hit 但 wakeWordEnabled=false → 忽略'))
      .catch(() => {})
    return
  }
  // Re-entrancy guard: Web Speech may fire multiple hits while we start listening.
  if (onWakeWordHit._busy) {
    console.log('[background-voice] Wake word hit ignored (busy)')
    void import('./xiaomi-voice/voice-file-log.js')
      .then(({ voiceFeLog }) =>
        voiceFeLog(
          '唤醒',
          `收到 hit 但处理中 busy → 忽略 asr=「${String(ev?.detail?.asr || ev?.detail?.raw || '').slice(0, 40)}」`,
        ),
      )
      .catch(() => {})
    return
  }
  onWakeWordHit._busy = true
  console.log('[background-voice] Wake word hit! Opening 小V...')
  try {
    const { voiceFeLog, markWakeHitClock, noteWakeMilestone } = await import(
      './xiaomi-voice/voice-file-log.js',
    )
    markWakeHitClock()
    noteWakeMilestone('hit')
    const detail = ev?.detail || {}
    voiceFeLog(
      '会话',
      `收到 wake-word-hit → 开麦应答 backend=${detail.backend || wakeWordBackend || '?'} asr=「${String(detail.asr || detail.raw || '').slice(0, 40)}」`,
    )
  } catch {
    /* ignore */
  }

  try {
    await openXiaomiForWake()
    // prefer/即将进 Frame：必须 skipFrame。开面板后舞台异步起管线，此时 framePipe 常仍 false，
    // 若不跳过，stopAll 可能误伤刚连上的 Frame session。
    try {
      const { stopAllAssistantSpeech } = await import('./speech-client.js')
      const prefer = isPreferXiaomiVoice()
      let framePipe = prefer
      if (!framePipe) {
        try {
          const { isXiaomiFramePipelineActive } = await import('./xiaomi-voice/index.js')
          framePipe = !!isXiaomiFramePipelineActive?.()
        } catch {
          framePipe = false
        }
      }
      stopAllAssistantSpeech({ reason: 'wake-word-hit', skipFrame: framePipe })
      notifyTTSStopped()
    } catch {
      /* ignore */
    }
    try {
      const { bargeInXiaomiFrame, isXiaomiFrameSessionActive, isXiaomiFramePlaying } = await import(
        './xiaomi-voice/index.js',
      )
      // 仅真在播报时 barge；空闲会话勿抬 min_turn
      if (isXiaomiFrameSessionActive() && isXiaomiFramePlaying?.()) {
        bargeInXiaomiFrame({ reason: 'wake-word-hit' })
      }
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

    // 小V 语音全屏 / prefer：麦归 Frame（舞台会自启管线）。切勿再开 continuous——
    // 旧竞态：open 后 Frame 尚未 _running，误开 continuous → 双 ASR + stopAll 风暴。
    // 再等最多 ~1.5s 让舞台拉起 Frame（open 返回时 xw/frame 常仍是 false）。
    let frameActive = false
    let xwOn = false
    const prefer = isPreferXiaomiVoice()
    for (let i = 0; i < 20; i++) {
      try {
        const { isXiaomiFramePipelineActive } = await import('./xiaomi-voice/index.js')
        frameActive = !!isXiaomiFramePipelineActive()
      } catch {
        frameActive = false
      }
      try {
        const { isXwVoiceMode } = await import('./xw-voice-mode.js')
        xwOn = !!isXwVoiceMode()
      } catch {
        xwOn = false
      }
      if (frameActive) break
      if (!prefer && !xwOn) break
      await new Promise((r) => setTimeout(r, 75))
    }
    if (frameActive || xwOn || prefer) {
      // Frame 路径：口头「在呢」改由 pipeline_ready 开麦成功后播放（HTTP 固定句），
      // 此处只 toast，避免与 getUserMedia 抢跑。
      try {
        const { toast } = await import('../components/toast.js')
        toast('小V在听，请说…', 'info')
      } catch {
        /* ignore */
      }
      void setVoiceTrayState('recording')
      try {
        const { voiceFeLog } = await import('./xiaomi-voice/voice-file-log.js')
        voiceFeLog(
          '会话',
          `唤醒命中 → 小V全屏/Frame 接管（frame=${frameActive} xw=${xwOn} prefer=${prefer}）不开 continuous；「在呢」等开麦后播`,
        )
      } catch {
        /* ignore */
      }
      return
    }

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
    if (result === 'paused' || result === 'empty' || result === 'exited') return
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
    } else if (wakeWordBackend === 'native-kws') {
      const { pauseNativeEar } = await import('./wake-word-native.js')
      await pauseNativeEar()
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
  // Frame 管线已占麦 / 正在播时再开唤醒耳 = 聋耳 + 抢麦
  // 仅有 Frame session（continuous 分句 TTS）不算占麦，允许恢复唤醒耳
  try {
    const { isXiaomiFramePipelineActive, isXiaomiFramePlaying } = await import(
      './xiaomi-voice/index.js',
    )
    if (isXiaomiFramePipelineActive?.() || isXiaomiFramePlaying?.()) {
      _voiceExitLog(
        `恢复唤醒耳跳过：Frame 占麦/在播 pipeline=${!!isXiaomiFramePipelineActive?.()} playing=${!!isXiaomiFramePlaying?.()}`,
      )
      return
    }
  } catch {
    /* ignore */
  }
  try {
    if (wakeWordBackend === 'webspeech') {
      const { startWebSpeechEar } = await import('./wake-word-webspeech.js')
      await startWebSpeechEar()
    } else if (wakeWordBackend === 'native-kws') {
      const { resumeNativeEarCapture } = await import('./wake-word-native.js')
      await resumeNativeEarCapture()
    } else if (wakeWordBackend === 'kws') {
      const { startEar } = await import('./wake-word.js')
      await startEar()
    }
    _voiceExitLog(`唤醒耳已恢复 backend=${wakeWordBackend || '-'}`)
  } catch (e) {
    console.warn('[background-voice] resume wake ear failed:', e?.message)
    _voiceExitLog(`唤醒耳恢复失败：${e?.message || e}`)
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
/** 已发问、等助手回复/播报：此间勿因 ASR partial 重挂空闲 */
let _awaitingAssistantReply = false
/** 空闲计时挂载日志节流 */
let _lastIdleArmLogAt = 0

/** 默认 45s（原先 20s 太急：模型/播报刚完用户还在想下一句就被退下）；localStorage `evoflow-voice-idle-farewell-ms` 可覆盖（≥15000） */
function _continuousIdleFarewellMs() {
  try {
    const v = parseInt(localStorage.getItem('evoflow-voice-idle-farewell-ms') || '', 10)
    if (Number.isFinite(v) && v >= 15000) return v
  } catch {
    /* ignore */
  }
  return 45000
}

function _voiceExitLog(message) {
  void import('./xiaomi-voice/voice-file-log.js')
    .then(({ voiceFeLog }) => voiceFeLog('退出', message))
    .catch(() => {})
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
  // 等模型/播报期间挂空闲 = 思考中被退下；等 notifyTTSStopped 再挂
  if (_awaitingAssistantReply) return
  const ms = _continuousIdleFarewellMs()
  _continuousIdleTimer = setTimeout(() => {
    _continuousIdleTimer = null
    void _runContinuousIdleFarewell()
  }, ms)
  const now = Date.now()
  if (!_lastIdleArmLogAt || now - _lastIdleArmLogAt > 15000) {
    _lastIdleArmLogAt = now
    _voiceExitLog(`常听空闲计时已挂 idle_ms=${ms}（无人说话将自动退下）`)
  }
}

/**
 * 空闲退下：播固定音效 → 关闭常听（唤醒耳恢复）。
 * Frame session / 本地仍在播时推迟，避免「回复还没说完就先退下了」。
 */
async function _runContinuousIdleFarewell() {
  if (!continuousModeEnabled || _continuousFarewellBusy) return

  let framePlaying = false
  let frameSession = false
  let framePipeline = false
  let legacyBusy = false
  try {
    const { isSpeechPlaybackBusy } = await import('./speech-client.js')
    legacyBusy = !!isSpeechPlaybackBusy()
  } catch {
    legacyBusy = false
  }
  try {
    const fr = await import('./xiaomi-voice/index.js')
    framePlaying = !!fr.isXiaomiFramePlaying?.()
    frameSession = !!fr.isXiaomiFrameSessionActive?.()
    framePipeline = !!fr.isXiaomiFramePipelineActive?.()
  } catch {
    /* ignore */
  }
  if (framePlaying || legacyBusy) {
    _voiceExitLog(
      `空闲退下推迟：仍在播报 framePlaying=${framePlaying} legacyBusy=${legacyBusy}`,
    )
    _armContinuousIdleTimer()
    return
  }

  _continuousFarewellBusy = true
  _clearContinuousIdleTimer()
  _voiceExitLog(
    `空闲自动退下开始 idle_ms=${_continuousIdleFarewellMs()} frameSession=${frameSession} framePipeline=${framePipeline}`,
  )
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
      _voiceExitLog(`空闲退下音效失败：${e?.message || e}`)
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
        // 仅 Frame 管线仍占麦时保留聆听；否则关掉 Frame session，真正退下并恢复唤醒耳
        let keepVoice = false
        try {
          const { isXiaomiFramePipelineActive, stopXiaomiFrameSession } = await import(
            './xiaomi-voice/index.js',
          )
          keepVoice = !!isXiaomiFramePipelineActive?.()
          if (!keepVoice) {
            try {
              stopXiaomiFrameSession?.()
            } catch {
              /* ignore */
            }
          }
        } catch {
          keepVoice = false
        }
        if (keepVoice) {
          setPreferXiaomiVoice(true)
          void setVoiceTrayState('recording')
          _voiceExitLog(
            '常听空闲退下，但 Frame 管线仍占麦 → 继续聆听偏好（不恢复唤醒耳）',
          )
        } else {
          setPreferXiaomiVoice(false)
          void setVoiceTrayState('idle')
          _voiceExitLog('常听空闲退下完成 → 空闲 + 恢复唤醒耳')
          void resumeWakeEarAfterContinuous()
        }
      } else {
        _voiceExitLog('空闲退下结束时 continuous 已关，跳过收尾')
      }
    } catch (e) {
      console.warn('[background-voice] idle farewell stop failed:', e?.message || e)
      _voiceExitLog(`空闲退下收尾失败：${e?.message || e}`)
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
    _voiceExitLog('用户关闭常听（toggleContinuousMode off）→ 停 Frame session + 恢复唤醒耳')
    _clearContinuousIdleTimer()
    _awaitingAssistantReply = false
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

  // 兜底注册（initBackgroundVoice 仅 Tauri；面板页也要 Frame busy）
  try {
    const { registerSpeechBusyExtra } = await import('./speech-client.js')
    const { isXiaomiFramePlaying } = await import('./xiaomi-voice/session-client.js')
    registerSpeechBusyExtra(() => !!isXiaomiFramePlaying?.())
  } catch {
    /* ignore */
  }

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

  // Create the continuous policy（参数见 voice-continuous-policy）
  continuousPolicy = createContinuousPolicy({
    getText: () => getContinuousTranscript(),
    // chatSend 整轮占用 isSending 时先别 fire（由 bridge 排队 + 此处重试）
    canSend: () => !isVoiceSendBusy(),
    sendText: (text) => {
      const cleaned = String(text || '').trim()
      if (!cleaned) return
      // 真正出手后再清转写，避免「拒绝发送却已清空」导致卡死
      resetContinuousTranscript()
      _clearContinuousIdleTimer() // 用户已开口，等 AI 说完再重新计空闲
      _awaitingAssistantReply = true
      void handleVoiceCommandText(cleaned, { global: true })
        .then(() => {
          // 本轮若无 TTS（播报关/短答无声），仍要重新挂空闲计时。
          // 等够长：工具轮常要几十秒；Frame 有会话时交给 notifyTTSStopped。
          window.setTimeout(() => {
            if (!continuousModeEnabled || _continuousFarewellBusy) return
            void Promise.all([
              import('./speech-client.js'),
              import('./xiaomi-voice/session-client.js'),
            ])
              .then(([sc, fr]) => {
                if (sc.isAssistantSpeaking?.() || sc.isSpeechPlaybackBusy?.()) return
                if (fr.isXiaomiFramePlaying?.()) return
                if (fr.isXiaomiFrameSessionActive?.()) {
                  _voiceExitLog('发问后兜底空闲：Frame 会话仍开且未在播 → 暂不挂计时（等播完）')
                  return
                }
                _awaitingAssistantReply = false
                _armContinuousIdleTimer()
              })
              .catch(() => {
                _awaitingAssistantReply = false
                _armContinuousIdleTimer()
              })
          }, 90000)
        })
        .catch(() => {
          _awaitingAssistantReply = false
          void setVoiceTrayState('idle')
          _voiceExitLog('常听发问失败 → 重新挂空闲计时')
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
      // 本地停播后 resumeSession(true) 开 ASR（不发服务端 barge_in）。
      // 禁止对 Frame 发 barge_in（会抬 min_turn，回声误触直接废掉整轮）。
      const now = Date.now()
      if (_continuousLastStopTtsAt && now - _continuousLastStopTtsAt < 400) return
      _continuousLastStopTtsAt = now
      void import('./xiaomi-voice/index.js')
        .then(({ isXiaomiFrameSessionActive, stopXiaomiFrameLocalPlayback }) => {
          if (isXiaomiFrameSessionActive?.()) {
            void import('./xiaomi-voice/voice-file-log.js')
              .then(({ voiceFeLog }) =>
                voiceFeLog('打断', 'continuous barge → 本地停播（不 barge_in）'),
              )
              .catch(() => {})
            stopXiaomiFrameLocalPlayback?.({ reason: 'continuous-local-stop' })
            const recorder = getContinuousRecorder()
            if (recorder?.suspendedByTTS) {
              void recorder.resumeFromTTS(true).catch(() => {})
            }
            return
          }
          void import('./xiaomi-voice/voice-file-log.js')
            .then(({ voiceFeLog }) =>
              voiceFeLog('打断', 'continuous 判定用户开口，停止 TTS（legacy）'),
            )
            .catch(() => {})
          void import('./speech-client.js').then(({ stopTTS }) => stopTTS())
          const recorder = getContinuousRecorder()
          if (recorder?.suspendedByTTS) {
            void recorder.resumeFromTTS(true).catch(() => {})
          }
        })
        .catch(() => {
          void import('./speech-client.js').then(({ stopTTS }) => stopTTS())
        })
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
        // 等模型时别把「思考中」盖回聆听（舞台会跟着跳）
        if (!_awaitingAssistantReply) {
          void setVoiceTrayState('recording')
        }
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
  _awaitingAssistantReply = true
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
  // 本地停播（回声 barge）时模型可能仍在生成：勿清 awaiting，否则空闲计时/托盘会误以为轮次结束
  void import('../components/global-assistant/assistant-store.js')
    .then(({ getState }) => {
      const stillStreaming = !!getState?.()?.streaming
      if (!stillStreaming) {
        _awaitingAssistantReply = false
      }
      if (!continuousModeEnabled || !isContinuousCaptureActive() || _continuousFarewellBusy) return
      if (!stillStreaming) {
        void setVoiceTrayState('recording')
        _armContinuousIdleTimer()
      } else {
        // 仍在生成：保持 processing，允许用户继续说（排队到 send 空闲）
        void setVoiceTrayState('processing')
      }
    })
    .catch(() => {
      _awaitingAssistantReply = false
      if (continuousModeEnabled && isContinuousCaptureActive() && !_continuousFarewellBusy) {
        void setVoiceTrayState('recording')
        _armContinuousIdleTimer()
      }
    })
}

/**
 * Whether continuous capture is actively listening for user speech
 * (wake-word ear alone does not count). Follow-up: import isVoiceFollowUpActive.
 */
export function isConversationListeningActive() {
  return !!(continuousModeEnabled && isContinuousCaptureActive())
}

/**
 * Route a recognized voice command: exit / stop-listen / stop-TTS / normal send.
 * @param {string} text
 * @param {{ global?: boolean, xiaomi?: boolean }} [opts]
 * @returns {Promise<'exited' | 'paused' | 'tts_stopped' | 'sent' | 'empty'>}
 */
export async function handleVoiceCommandText(text, opts = {}) {
  const cleaned = String(text || '').trim()
  if (!cleaned) return 'empty'

  // Frame 占麦时只允许本地口令（退出/停播）；普通转写由 turn_end 发问，勿再走 continuous 发送。
  try {
    const { isXiaomiFramePipelineActive } = await import('./xiaomi-voice/index.js')
    if (isXiaomiFramePipelineActive?.()) {
      try {
        const { tryHandleXiaomiVoiceLocalCommand } = await import('./xiaomi-voice-close.js')
        const handled = await tryHandleXiaomiVoiceLocalCommand(cleaned, {
          source: 'continuous-while-frame',
        })
        if (handled === 'exited') return 'exited'
        if (handled === 'tts_stopped') {
          notifyTTSStopped()
          return 'tts_stopped'
        }
      } catch {
        /* ignore */
      }
      try {
        const { voiceFeLog } = await import('./xiaomi-voice/voice-file-log.js')
        voiceFeLog(
          '会话',
          `Frame 占麦 → 忽略 continuous 发问：「${cleaned.slice(0, 40)}」`,
        )
      } catch {
        /* ignore */
      }
      return 'empty'
    }
  } catch {
    /* ignore */
  }

  // 口令关舞台 / 停播报：客户端直接处理，不发给 AI
  try {
    const { tryHandleXiaomiVoiceLocalCommand } = await import('./xiaomi-voice-close.js')
    const handled = await tryHandleXiaomiVoiceLocalCommand(cleaned, { source: 'continuous' })
    if (handled === 'exited') return 'exited'
    if (handled === 'tts_stopped') {
      notifyTTSStopped()
      return 'tts_stopped'
    }
  } catch {
    /* ignore */
  }

  const { isStopListenCommand } = await import('./voice-listen-control.js')
  if (isStopListenCommand(cleaned)) {
    await pauseConversationListening({ reason: 'voice' })
    return 'paused'
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
 * @param {{ reason?: 'voice' | 'button' | 'reset' | 'exit-xw-voice', silent?: boolean }} [opts]
 */
export async function pauseConversationListening(opts = {}) {
  const silent = !!opts.silent
  const reason = String(opts.reason || 'unknown')
  _voiceExitLog(
    `暂停监听 pauseConversationListening reason=${reason} silent=${silent} continuous=${continuousModeEnabled}`,
  )

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
    stopAllAssistantSpeech({ reason: 'pause-listening' })
  } catch {
    /* ignore */
  }

  // 即使 continuousModeEnabled 已假，也要停 capture（Frame 启动时可能只停了半套）
  const hadContinuous = continuousModeEnabled || isContinuousCaptureActive()
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
  }
  if (hadContinuous || isContinuousCaptureActive()) {
    try {
      await stopContinuousCapture()
    } catch {
      /* ignore */
    }
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
 * Frame 管线接管麦：关掉 continuous 模式与 ASR，但不恢复唤醒耳、不改 preferXiaomi。
 */
export async function stopContinuousListeningForFrame() {
  _clearContinuousIdleTimer()
  const wasOn = continuousModeEnabled || isContinuousCaptureActive()
  continuousModeEnabled = false
  if (continuousPolicy) {
    continuousPolicy.reset()
    continuousPolicy = null
  }
  try {
    const { clearTTSNotifyCallbacks } = await import('./voice-reply-speech.js')
    clearTTSNotifyCallbacks()
  } catch {
    /* ignore */
  }
  try {
    await stopContinuousCapture()
  } catch {
    /* ignore */
  }
  if (wasOn) {
    try {
      const { voiceFeLog } = await import('./xiaomi-voice/voice-file-log.js')
      voiceFeLog('会话', 'Frame 接管 → continuous 已停（防双 ASR / 误 barge）')
    } catch {
      /* ignore */
    }
  }
}

/**
 * 退出小V语音全屏：停 Frame 管线 + continuous ASR + 播报，只留唤醒耳。
 * 防止「面板关了 ASR 还在灌输入框」（日志 source=输入框 + ASR glitch）。
 * 小V 听麦/发问/播报只活在「小微对话」；退出后主对话绝不承接。
 */
export async function shutdownXiaomiVoiceRuntime() {
  _voiceExitLog('退出语音全屏 shutdownXiaomiVoiceRuntime → 停 Frame / continuous / 播报（仅留唤醒耳）')
  try {
    const { voiceFeLog } = await import('./xiaomi-voice/voice-file-log.js')
    voiceFeLog('会话', '退出语音全屏 → 停止 Frame / continuous / 播报（仅留唤醒耳；主对话不承接）')
  } catch {
    /* ignore */
  }
  try {
    const { interruptXiaomiFrame, stopXiaomiFramePipeline, isXiaomiFramePipelineActive } =
      await import('./xiaomi-voice/index.js')
    if (isXiaomiFramePipelineActive?.()) {
      try {
        await interruptXiaomiFrame?.()
      } catch {
        /* ignore */
      }
    }
    stopXiaomiFramePipeline?.()
  } catch {
    /* ignore */
  }
  // 先掐 prefer / 排队句，再 pause：避免退出瞬间迟到 partial 仍标「小V」或灌主输入框
  try {
    setPreferXiaomiVoice(false)
    clearPendingVoiceSend()
  } catch {
    /* ignore */
  }
  await pauseConversationListening({ reason: 'exit-xw-voice', silent: true })
  // 勿把小V 期间的「语音播报」泄漏到主对话文本轮
  try {
    const { restoreXiaomiVoiceReplyAfterExit } = await import('./xiaomi-voice-defaults.js')
    await restoreXiaomiVoiceReplyAfterExit()
  } catch {
    /* ignore */
  }
  // 闸门收尾：已经退出（关面板后不应再听用户说话）
  try {
    const { noteVoiceModeGate } = await import('./xiaomi-voice/voice-file-log.js')
    noteVoiceModeGate('exited', {
      source: 'shutdownXiaomiVoiceRuntime',
      reason: 'runtime-stopped',
    })
  } catch {
    /* ignore */
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
