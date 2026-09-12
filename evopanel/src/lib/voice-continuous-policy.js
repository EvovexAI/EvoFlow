/**
 * 持续监听策略：麦克风常开、流式识别、静默自动发送、TTS 播放期间 barge-in 打断检测。
 * 移植自既有语音模块 voice-continuous.js，适配 EvoFlow 的 speech-client / background-voice 架构。
 *
 * 核心机制：
 * 1. 自动发送：转写文本停更 SILENCE_SEND_MS 后整条发出（底噪不刷新计时）
 * 2. Barge-in 两阶段检测：
 *    阶段一：连续 DUCK_TRIGGER_FRAMES 帧高振幅 → duck（降低 TTS 音量）
 *    阶段二：duck 中再持续 DUCK_SUSTAIN_FRAMES 帧 → 判定语音 → 真正打断（停止 TTS）
 *             duck 中连续 DUCK_DECAY_FRAMES 帧低振幅 → 判定噪音 → 恢复音量
 */

// ─── 自动发送参数 ───
const SILENCE_SEND_MS = (() => {
  const v = parseInt(localStorage.getItem('evoflow-voice-silence-ms') || '', 10)
  return Number.isFinite(v) && v >= 800 ? v : 2000
})()

// ─── 打断检测参数 ───
const BARGEIN_THRESHOLD = 0.09
const BARGEIN_WARMUP_MS = 350     // TTS 开始后短暂忽略（等 AEC 适应）；尽量缩短体感延迟

// ─── Duck 模式参数 ───
const DUCK_TRIGGER_FRAMES = 2     // 连续 2 帧高振幅 → duck（≈30ms）
const DUCK_SUSTAIN_FRAMES = 6     // duck 中再持续 6 帧 → 语音 → 打断
const DUCK_DECAY_FRAMES   = 5     // duck 中连续低振幅 → 噪音 → 恢复
const DUCK_MAX_MS         = 1200  // duck 最长持续，超时恢复
const ECHO_MARGIN_VOL     = 0.025 // TTS 回声基线外还得多出的音量
const ECHO_HARD_VOL       = 0.14  // 极高音量直接允许打断候选

// ─── 误触发恢复 ───
const BARGEIN_NO_SPEECH_MS = 3500 // 打断后 3.5s 无语音 → 噪音误触发

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

  // ─── 自动发送状态 ───
  let autoSendTimer = null
  let lastTranscriptActivityTs = 0
  let lastObservedText = ''

  // ─── 打断检测状态 ───
  let bargeinFrames = 0
  let duckActive = false
  let duckHighFrames = 0
  let duckLowFrames = 0
  let duckStartTime = 0
  let ttsEchoFloor = 0
  let ttsActive = false
  let ttsStartTime = 0

  // ─── 误触发恢复 ───
  let bargeinNoSpeechTimer = null

  function cancelAutoSend() {
    if (autoSendTimer) { clearTimeout(autoSendTimer); autoSendTimer = null }
  }

  function clearNoSpeechTimer() {
    if (bargeinNoSpeechTimer) {
      clearTimeout(bargeinNoSpeechTimer)
      bargeinNoSpeechTimer = null
    }
  }

  function resetEchoFloor() { ttsEchoFloor = 0 }

  function learnEchoFloor(vol, { force = false } = {}) {
    const raw = Math.max(0, Number(vol) || 0)
    if (!force && raw > BARGEIN_THRESHOLD) return
    const sample = Math.min(raw, BARGEIN_THRESHOLD)
    ttsEchoFloor = ttsEchoFloor ? (ttsEchoFloor * 0.9 + sample * 0.1) : sample
  }

  function isBargeinCandidate(vol) {
    if (vol <= BARGEIN_THRESHOLD) return false
    if (!ttsActive) return true
    const guard = Math.max(BARGEIN_THRESHOLD, ttsEchoFloor + ECHO_MARGIN_VOL)
    return vol >= ECHO_HARD_VOL || vol > guard
  }

  /**
   * 通知策略：TTS 开始播放。
   */
  function onTTSStart() {
    ttsActive = true
    ttsStartTime = Date.now()
    resetEchoFloor()
    bargeinFrames = 0
    duckActive = false
    duckHighFrames = 0
    duckLowFrames = 0
  }

  /**
   * 通知策略：TTS 播放结束（正常播完或被停止）。
   */
  function onTTSStop() {
    ttsActive = false
    if (duckActive) {
      unduckTTS?.()
      duckActive = false
    }
    resetEchoFloor()
  }

  /**
   * 每帧音量回调（由 mic analyser 驱动）。
   * @param {number} vol 0~1 归一化音量
   */
  function onFrame(vol) {
    // ── 打断检测：TTS 播放中 ──
    if (ttsActive) {
      const aecReady = Date.now() - ttsStartTime > BARGEIN_WARMUP_MS

      if (aecReady && !duckActive) {
        learnEchoFloor(vol, { force: !aecReady })
      }

      if (aecReady) {
        const candidate = isBargeinCandidate(vol)

        if (!duckActive) {
          // 阶段一：等待触发 duck
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
          // 阶段二：duck 中判断语音 vs 噪音
          const elapsed = Date.now() - duckStartTime
          if (candidate) {
            duckHighFrames++
            duckLowFrames = 0
            if (duckHighFrames >= DUCK_SUSTAIN_FRAMES) {
              // 持续高振幅 → 语音 → 真正打断
              duckActive = false
              duckHighFrames = 0
              onTTSStop()
              stopTTS?.()
              // 启动误触发恢复计时
              clearNoSpeechTimer()
              bargeinNoSpeechTimer = setTimeout(() => {
                bargeinNoSpeechTimer = null
                // 3.5s 内没有新语音输入 → 判定为噪音误触发
                // EvoFlow 简化处理：不恢复 TTS，用户可重新提问
              }, BARGEIN_NO_SPEECH_MS)
            }
          } else {
            duckLowFrames++
            duckHighFrames = 0
            if (duckLowFrames >= DUCK_DECAY_FRAMES || elapsed >= DUCK_MAX_MS) {
              // 迅速消退 → 冲击噪音 → 恢复音量
              duckActive = false
              duckLowFrames = 0
              unduckTTS?.()
            }
          }
        }
      }
    }
  }

  /**
   * 收到一条 transcript 后的策略：刷新自动发送计时。
   */
  function onTranscript() {
    // 收到真实语音 → 取消误触发恢复
    clearNoSpeechTimer()

    const currentText = (getText?.() || '').trim()
    if (!currentText || currentText === lastObservedText) return
    lastObservedText = currentText
    scheduleAutoSend()
  }

  /**
   * 攒成一条，转写停更 SILENCE_SEND_MS 后整条发出。
   * 底噪不产生新字，不会刷新计时。
   */
  function scheduleAutoSend() {
    // PTT 门控：PTT 按住期间禁用持续模式的自动发送
    if (isPttHolding && isPttHolding()) return
    lastTranscriptActivityTs = Date.now()
    if (autoSendTimer) return
    const tick = () => {
      const idle = Date.now() - lastTranscriptActivityTs
      if (idle >= SILENCE_SEND_MS) {
        autoSendTimer = null
        lastObservedText = ''
        const text = (getText?.() || '').trim()
        if (text) {
          onProcessing?.()
          sendText(text)
        }
      } else {
        autoSendTimer = setTimeout(tick, SILENCE_SEND_MS - idle)
      }
    }
    autoSendTimer = setTimeout(tick, SILENCE_SEND_MS)
  }

  /**
   * 重置所有状态（新会话开始或停止时调用）。
   */
  function reset() {
    cancelAutoSend()
    clearNoSpeechTimer()
    bargeinFrames = 0
    duckActive = false
    duckHighFrames = 0
    duckLowFrames = 0
    resetEchoFloor()
    ttsActive = false
    lastTranscriptActivityTs = 0
    lastObservedText = ''
  }

  return {
    onFrame,
    onTranscript,
    onTTSStart,
    onTTSStop,
    cancelAutoSend,
    reset,
    get isDucking() { return duckActive },
    get ttsActive() { return ttsActive },
  }
}
