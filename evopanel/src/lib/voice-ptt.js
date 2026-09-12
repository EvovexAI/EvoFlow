/**
 * PTT（Push-To-Talk）策略 — 移植自既有语音模块 voice-ptt.js。
 *
 * 叠加语义：持续监听正在跑时按 PTT，不重开麦克风，只"强制立即发一次"。
 * 底层录音由 voice-capture-service 管理；本模块只做门控 + 松手发送策略。
 *
 * EvoFlow 没有 legacy voice module 那样的统一 core 对象，这里通过 deps 注入：
 * - 录音接口（startCapture / stopCapture / cancelCapture / getPartialTranscript / isCaptureActive）
 * - 持续模式接口（isContinuousActive / getContinuousTranscript / resetContinuousTranscript / cancelContinuousAutoSend）
 * - 发送接口（sendText）
 * - 托盘状态回调（onTrayState）
 * - 演示模式接口（isDemoActive / startDemo / stopDemo / demoResult）
 * - 确认语接口（startSimpleAck）
 *
 * 保留机制：
 * 1. 60s 超时 — 按住超过 60s 自动松手（send=true 正常发送）
 * 2. 窗口失焦 — pttEnd({ send: false }) 丢弃半句不发
 * 3. 吞尾机制 — 持续模式下 PTT 松手后吞掉云端 flush 的尾随 final
 * 4. 叠加语义 — 持续监听激活时按 PTT 立即发送当前识别文字，不重开 mic
 * 5. 异步队列化松手 — releaseChain 串行化多次松手事件
 */

const PTT_TIMEOUT_MS = 60000
/** 短于此时长视为误触点按，提示「按住说话」而不发送 */
const PTT_MIN_HOLD_MS = 400
// 持续模式下 PTT 松手后，等待云端 flush 尾随 final 的超时
const PTT_TAIL_WAIT_MS = 800
const PTT_TAIL_TICK_MS = 100

export const PTT_SHORT_PRESS_HINT = '请按住语音键说话，松手或再按一次发送'

/**
 * @param {{
 *   startCapture: (opts?: { onPartial?: (text: string) => void, onLevel?: (levels: number[]) => void }) => Promise<void>,
 *   stopCapture: () => Promise<{ transcript: string, error?: Error }>,
 *   getPartialTranscript: () => string,
 *   cancelCapture: () => void,
 *   isCaptureActive: () => boolean,
 *   isCaptureRecording?: () => boolean,
 *   // 持续模式接口
 *   isContinuousActive: () => boolean,
 *   getContinuousTranscript: () => string,
 *   resetContinuousTranscript: () => void,
 *   cancelContinuousAutoSend: () => void,
 *   suppressContinuousTranscripts?: (ms: number) => void,
 *   // 发送
 *   sendText: (text: string, opts?: { global?: boolean }) => Promise<void> | void,
 *   // 状态
 *   onTrayState: (state: 'idle' | 'recording' | 'processing' | 'running' | 'speaking') => void,
 *   // 浮窗
 *   showOverlay?: () => Promise<unknown>,
 *   hideOverlay?: () => Promise<unknown>,
 *   // 演示模式
 *   isDemoActive: () => boolean,
 *   startDemo: (opts?: object) => void,
 *   stopDemo: () => void,
 *   demoResult: () => string,
 *   // 确认语
 *   startSimpleAck?: (cb: (state: string) => void) => Promise<void> | void,
 *   // TTS 停止（按下时打断当前播报）
 *   stopAllSpeech?: () => Promise<void> | void,
 *   // 麦克风探测
 *   probeMicrophone?: () => Promise<boolean>,
 *   onMicAccessError?: (e: unknown) => boolean,
 *   onMicError?: (e: unknown) => void,
 *   // 开麦前就绪检查
 *   ensureSpeechReady?: () => Promise<boolean>,
 *   isSendReady?: () => boolean,
 *   // 演示模式 toast（一次性）
 *   onDemoToast?: () => void,
 * }} deps
 */
export function createPttController(deps) {
  const d = deps || {}

  /** 是否由本次 PTT 开启的 mic（松手时决定是否关 mic） */
  let pttStartedMic = false
  /** PTT 按下中 */
  let pushDown = false
  /** 60s 超时计时器 */
  let pushDownTimeout = null
  /** 松手流程串行化（防止并发） */
  let voiceStopInFlight = false
  /** 松手事件链（窗口失焦等场景可能连续触发） */
  let releaseChain = null
  /** 持续模式 PTT 门控：按住期间屏蔽持续模式的自动发送 */
  let pttHolding = false
  /** 持续模式下 PTT 松手后的吞尾计时 */
  let suppressTailTimer = null
  /** 录音正在启动中（pttStart 的 await 链还没走完） */
  let voiceStarting = false
  /** 启动过程中收到松手请求 → 排队，启动完成后自动执行 */
  let pendingStop = null
  /** 本次按下时刻（用于短按误触判定） */
  let pushDownAt = 0

  function isPushDown() {
    return pushDown
  }

  function isPttHolding() {
    return pttHolding
  }

  function clearPushDownTimeout() {
    if (pushDownTimeout) {
      clearTimeout(pushDownTimeout)
      pushDownTimeout = null
    }
  }

  function setPushDown(value) {
    pushDown = value
    clearPushDownTimeout()
    if (value) {
      pushDownAt = Date.now()
      pushDownTimeout = setTimeout(() => {
        if (pushDown) {
          console.warn('[voice-ptt] 录音超时，自动重置状态')
          queueVoicePushUp()
        }
      }, PTT_TIMEOUT_MS)
    }
  }

  // ─── 浮窗便捷封装 ───
  async function showOverlay() {
    if (d.showOverlay) return d.showOverlay()
  }
  async function hideOverlay() {
    if (d.hideOverlay) return d.hideOverlay()
  }

  // ─── 演示模式进入 ───
  async function enterDemoMode(opts = {}) {
    d.startDemo?.({})
    d.onTrayState?.('recording')
    if (opts.toastOnce && d.onDemoToast) d.onDemoToast()
  }

  /**
   * PTT 按下处理。
   *
   * 叠加语义：
   * - 持续监听激活 → 不重开 mic，立即发送当前识别文字
   * - 已在录音 → 忽略重复按下（松手发送）
   * - 否则 → 开麦录音
   */
  async function pttStart() {
    if (voiceStopInFlight) return

    // ── 叠加语义：持续监听跑着时按 PTT = 立即发送当前识别文字 ──
    if (d.isContinuousActive && d.isContinuousActive()) {
      const text = (d.getContinuousTranscript?.() || '').trim()
      if (text) {
        d.resetContinuousTranscript?.()
        d.cancelContinuousAutoSend?.()
        d.onTrayState?.('processing')
        try {
          await d.sendText(text, { global: true })
        } catch (_) {
          d.onTrayState?.('idle')
        }
      }
      return
    }

    // ── 已在录音/演示 → 再按一次立即发送（兼容松手事件丢失，也更灵活） ──
    const captureActive = d.isCaptureActive()
    const demoActive = d.isDemoActive?.()
    if (pushDown || captureActive || demoActive) {
      if (demoActive || captureActive || pushDown) {
        queueVoicePushUp({ send: true })
      }
      return
    }

    // ── 正常开麦流程 ──
    setPushDown(true)
    voiceStarting = true
    pttStartedMic = false

    try {
      // 按下时打断当前 TTS 播报
      if (d.stopAllSpeech) {
        try { await d.stopAllSpeech() } catch (_) {}
      }

      await showOverlay()

      // 麦克风探测
      const hasMic = d.probeMicrophone ? await d.probeMicrophone() : true
      if (!hasMic) {
        await enterDemoMode({ toastOnce: true })
        return
      }

      // 开麦前的就绪检查（语音配置 + 发送通道）
      const speechReady = d.ensureSpeechReady ? await d.ensureSpeechReady() : true
      const sendReady = d.isSendReady ? d.isSendReady() : true

      if (speechReady && sendReady) {
        try {
          await d.startCapture()
          // 启动期间已松手：绝不能再标成 recording，否则界面卡住要再按一次
          if (!pushDown || pendingStop) {
            pttStartedMic = false
            if (d.isCaptureActive()) {
              d.cancelCapture?.()
            }
            await hideOverlay()
            d.onTrayState?.('idle')
            const stopOpts = pendingStop
            pendingStop = null
            const heldMs = pushDownAt > 0 ? Date.now() - pushDownAt : 0
            if (stopOpts?.send !== false && heldMs < PTT_MIN_HOLD_MS) {
              d.onMicError?.(new Error(PTT_SHORT_PRESS_HINT))
            }
            return
          }
          pttStartedMic = true
          d.onTrayState?.('recording')
          return
        } catch (e) {
          // 麦克风权限错误 → 演示模式降级
          if (d.onMicAccessError && d.onMicAccessError(e)) {
            await enterDemoMode({ toastOnce: true })
            return
          }
          setPushDown(false)
          pttStartedMic = false
          pendingStop = null
          d.onTrayState?.('idle')
          await hideOverlay()
          d.onMicError?.(e)
          return
        }
      }

      // 语音未配置或发送未就绪 → 演示模式
      await enterDemoMode({ toastOnce: true })
    } finally {
      voiceStarting = false
      // 启动过程中收到了松手请求 → 立即执行停止+发送（仅当仍在按住录音态）
      if (pendingStop && pushDown && pttStartedMic) {
        const stopOpts = pendingStop
        pendingStop = null
        queueVoicePushUp(stopOpts)
      } else if (pendingStop) {
        // 已在上方 abort 分支处理
        pendingStop = null
      }
    }
  }

  /**
   * PTT 松手处理。
   *
   * @param {{ send?: boolean }} [opts]
   *   - send=true（默认）：停止录音 → 识别 → 发送
   *   - send=false：窗口失焦等非主动松手，丢弃半句不发
   */
  async function pttEnd(opts = {}) {
    const { send = true } = opts

    // 录音正在启动中 → 只排队，等 pttStart 结束后统一收尾（勿与 startCapture 并发）
    if (voiceStarting) {
      pendingStop = { send }
      setPushDown(false)
      return
    }

    if (voiceStopInFlight) return

    const wasActive = pushDown || d.isCaptureActive() || (d.isDemoActive?.() ?? false)
    setPushDown(false)

    if (!wasActive) {
      await hideOverlay()
      d.onTrayState?.('idle')
      return
    }

    voiceStopInFlight = true

    try {
      // ── 演示模式松手 ──
      if (d.isDemoActive && d.isDemoActive()) {
        d.stopDemo?.()
        await hideOverlay()
        const demoText = d.demoResult?.() || ''
        d.onTrayState?.('processing')
        try {
          if (d.startSimpleAck) await d.startSimpleAck((s) => d.onTrayState?.(s))
          await d.sendText(demoText, { global: true })
        } catch (_) {
          d.onTrayState?.('idle')
        }
        return
      }

      // ── 非主动松手（窗口失焦）：丢弃半句不发 ──
      if (!send) {
        d.cancelContinuousAutoSend?.()
        if (pttStartedMic || d.isCaptureActive()) {
          d.cancelCapture?.()
        } else {
          // 持续模式下：清掉当前攒的半句，吞尾 1.5s
          d.resetContinuousTranscript?.()
          suppressTail(1500)
        }
        pttStartedMic = false
        await hideOverlay()
        d.onTrayState?.('idle')
        return
      }

      // ── 正常松手：停止录音 → 识别 → 发送 ──
      if (!d.isCaptureActive() && !pttStartedMic) {
        await hideOverlay()
        d.onTrayState?.('idle')
        return
      }

      // 本轮由 PTT 开麦且按住过短 → 视为误触，不发送、不报「未识别」
      const heldMs = pushDownAt > 0 ? Date.now() - pushDownAt : 0
      if (pttStartedMic && heldMs < PTT_MIN_HOLD_MS) {
        console.log('[voice-ptt] short press discarded', heldMs, 'ms')
        d.cancelCapture?.()
        pttStartedMic = false
        await hideOverlay()
        d.onTrayState?.('idle')
        d.onMicError?.(new Error(PTT_SHORT_PRESS_HINT))
        return
      }

      await hideOverlay()
      d.onTrayState?.('processing')

      const startedThisPtt = pttStartedMic
      pttStartedMic = false

      const partial = d.getPartialTranscript?.() || ''
      const { transcript, error } = await d.stopCapture?.() || { transcript: '', error: undefined }
      let text = String(transcript || partial || '').trim()
      if (error && !text) {
        if (d.onMicAccessError && d.onMicAccessError(error)) {
          text = String(d.demoResult?.() || '').trim()
        } else {
          d.onTrayState?.('idle')
          d.onMicError?.(error)
          return
        }
      }

      if (!text) {
        d.onTrayState?.('idle')
        // 话筒点按开麦（非本轮 PTT）允许空结果提示；PTT 短按已在上方拦截
        d.onMicError?.(new Error(startedThisPtt ? '未识别到语音内容' : '未识别到语音内容'))
        return
      }

      // ── 发送 + 确认语 ──
      try {
        if (d.startSimpleAck) await d.startSimpleAck((s) => d.onTrayState?.(s))
        const sendResult = d.sendText(text, { global: true })
        if (sendResult && typeof sendResult.then === 'function') {
          await sendResult
        }
      } catch (e) {
        d.onTrayState?.('idle')
        d.onMicError?.(e)
      }
    } finally {
      voiceStopInFlight = false
    }
  }

  /**
   * 吞尾机制：持续模式下 PTT 松手后，吞掉云端 flush 的尾随 final。
   * 通过 recorder.suppressTranscripts 在 ASR 层面丢弃传入转录。
   */
  function suppressTail(ms) {
    if (suppressTailTimer) clearTimeout(suppressTailTimer)
    pttHolding = false
    d.cancelContinuousAutoSend?.()
    if (ms > 0) {
      // Tell the recorder to discard transcripts at ASR level
      if (d.suppressContinuousTranscripts) {
        d.suppressContinuousTranscripts(ms)
      }
      suppressTailTimer = setTimeout(() => {
        suppressTailTimer = null
      }, ms)
    }
  }

  /**
   * 异步队列化松手（串行化多次松手事件，防止并发）。
   * @param {{ send?: boolean }} [opts]
   */
  function queueVoicePushUp(opts) {
    releaseChain = (releaseChain || Promise.resolve())
      .then(() => pttEnd(opts))
      .catch((e) => console.warn('[voice-ptt] push up', e))
  }

  /**
   * 重置所有 PTT 状态（强制重置 / teardown 时调用）。
   */
  function reset() {
    setPushDown(false)
    pttStartedMic = false
    voiceStopInFlight = false
    pttHolding = false
    releaseChain = null
    voiceStarting = false
    pendingStop = null
    pushDownAt = 0
    if (suppressTailTimer) {
      clearTimeout(suppressTailTimer)
      suppressTailTimer = null
    }
  }

  return {
    pttStart,
    pttEnd,
    queueVoicePushUp,
    isPushDown,
    isPttHolding,
    reset,
  }
}
