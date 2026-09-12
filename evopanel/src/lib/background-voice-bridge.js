/**
 * 后台语音发消息桥接。
 * - 主对话：ChatApp 挂载时注册 voiceSendHandler
 * - 「小V小V」唤醒：走全局小V面板（xiaomiVoiceSendHandler）
 * 持续监听模式下，partial 文字也通过此桥接实时推到 ChatComposer / 小V面板。
 */

/** @type {((text: string, opts?: { global?: boolean, xiaomi?: boolean }) => void | Promise<void>) | null} */
let voiceSendHandler = null
/** @type {((text: string, opts?: { global?: boolean, xiaomi?: boolean }) => void | Promise<void>) | null} */
let xiaomiVoiceSendHandler = null
/** 防重锁：正在发送中就拒绝新请求，杜绝重复发消息 */
let isSending = false

// ─── 持续模式 / 全局 PTT partial 文字显示桥接 ───
/** @type {((text: string) => void) | null} */
let voicePartialHandler = null
/** @type {((text: string) => void) | null} */
let xiaomiVoicePartialHandler = null
/** @type {((text: string) => void) | null} */
let meetingVoicePartialHandler = null
/** @type {((text: string, opts?: { global?: boolean, xiaomi?: boolean, meeting?: boolean }) => void | Promise<void>) | null} */
let meetingVoiceSendHandler = null
/** @type {(() => void) | null} */
let voicePartialBeginHandler = null
/** @type {((opts: { cancelled?: boolean }) => void) | null} */
let voicePartialEndHandler = null
let voicePartialSessionActive = false
/** 唤醒会话期间：partial / send 优先小V */
let preferXiaomiVoice = false
/** AI员工聊天室打开时：全局 PTT / 快捷键优先会议室 */
let preferMeetingVoice = false

export const VOICE_CAPTURE_SESSION_END = 'evopanel:voice-capture-session-end'
export const VOICE_CAPTURE_SESSION_BEGIN = 'evopanel:voice-capture-session-begin'

/**
 * 「小V小V」唤醒回合：后续 transcript / partial 走全局小V。
 * @param {boolean} on
 */
export function setPreferXiaomiVoice(on) {
  preferXiaomiVoice = !!on
}

export function isPreferXiaomiVoice() {
  return preferXiaomiVoice
}

/**
 * AI员工聊天室前台：全局按住说话 / 桌面热键走会议室发送。
 * @param {boolean} on
 */
export function setPreferMeetingVoice(on) {
  preferMeetingVoice = !!on
}

export function isPreferMeetingVoice() {
  return preferMeetingVoice
}

/**
 * 注册 partial 文字回调（ChatApp 挂载时注册）。
 * 持续监听 / 全局按住说话时，ASR partial 结果通过此回调实时推到 ChatComposer 输入框。
 * @param {((text: string) => void) | null} fn
 */
export function registerVoicePartialHandler(fn) {
  voicePartialHandler = fn
}

export function unregisterVoicePartialHandler() {
  voicePartialHandler = null
}

/** @param {((text: string) => void) | null} fn */
export function registerXiaomiVoicePartialHandler(fn) {
  xiaomiVoicePartialHandler = fn
}

export function unregisterXiaomiVoicePartialHandler() {
  xiaomiVoicePartialHandler = null
}

/** @param {((text: string) => void) | null} fn */
export function registerMeetingVoicePartialHandler(fn) {
  meetingVoicePartialHandler = fn
}

export function unregisterMeetingVoicePartialHandler() {
  meetingVoicePartialHandler = null
}

/** @param {((text: string, opts?: { global?: boolean, xiaomi?: boolean, meeting?: boolean }) => void | Promise<void>) | null} fn */
export function registerMeetingVoiceSendHandler(fn) {
  meetingVoiceSendHandler = fn
  isSending = false
}

export function unregisterMeetingVoiceSendHandler() {
  meetingVoiceSendHandler = null
  isSending = false
}

/** @param {(() => void) | null} fn */
export function registerVoicePartialBeginHandler(fn) {
  voicePartialBeginHandler = fn
}

export function unregisterVoicePartialBeginHandler() {
  voicePartialBeginHandler = null
}

/** @param {((opts: { cancelled?: boolean }) => void) | null} fn */
export function registerVoicePartialEndHandler(fn) {
  voicePartialEndHandler = fn
}

export function unregisterVoicePartialEndHandler() {
  voicePartialEndHandler = null
}

/** 全局 PTT 开麦前：暂存当前草稿并清空输入框（与话筒按钮行为一致） */
export function beginVoicePartialSession() {
  if (voicePartialSessionActive) return
  voicePartialSessionActive = true
  voicePartialBeginHandler?.()
  try {
    window.dispatchEvent(new CustomEvent(VOICE_CAPTURE_SESSION_BEGIN))
  } catch {
    /* ignore */
  }
}

/** @param {{ cancelled?: boolean }} [opts] */
export function endVoicePartialSession(opts = {}) {
  if (!voicePartialSessionActive) return
  voicePartialSessionActive = false
  voicePartialEndHandler?.(opts)
  try {
    window.dispatchEvent(
      new CustomEvent(VOICE_CAPTURE_SESSION_END, { detail: { ...opts } }),
    )
  } catch {
    /* ignore */
  }
}

/**
 * 推送 partial 文字到 ChatComposer 或小V草稿区。
 * @param {string} text
 */
export function updateVoicePartialText(text) {
  const t = String(text || '')
  // 会议室打开时优先（唤醒小V 仍可抢占）
  if (!preferXiaomiVoice && preferMeetingVoice && typeof meetingVoicePartialHandler === 'function') {
    meetingVoicePartialHandler(t)
    return
  }
  if (preferXiaomiVoice && typeof xiaomiVoicePartialHandler === 'function') {
    xiaomiVoicePartialHandler(t)
    return
  }
  if (typeof voicePartialHandler === 'function') {
    voicePartialHandler(t)
  }
}

/**
 * @param {(text: string, opts?: { global?: boolean, xiaomi?: boolean }) => void | Promise<void>} fn
 */
export function registerVoiceSendHandler(fn) {
  if (voiceSendHandler) {
    console.warn('[background-voice-bridge] 检测到重复注册 handler，已先清理！')
  }
  voiceSendHandler = fn
  isSending = false
}

export function unregisterVoiceSendHandler() {
  voiceSendHandler = null
  isSending = false
}

/**
 * 全局小V面板注册（mountGlobalAssistant）。
 * @param {(text: string, opts?: { global?: boolean, xiaomi?: boolean }) => void | Promise<void>} fn
 */
export function registerXiaomiVoiceSendHandler(fn) {
  xiaomiVoiceSendHandler = fn
  isSending = false
}

export function unregisterXiaomiVoiceSendHandler() {
  xiaomiVoiceSendHandler = null
  isSending = false
}

export function isVoiceSendHandlerReady() {
  if (preferXiaomiVoice) {
    return typeof xiaomiVoiceSendHandler === 'function'
  }
  if (preferMeetingVoice) {
    return typeof meetingVoiceSendHandler === 'function'
  }
  return (
    typeof voiceSendHandler === 'function' ||
    typeof xiaomiVoiceSendHandler === 'function' ||
    typeof meetingVoiceSendHandler === 'function'
  )
}

export function isXiaomiVoiceSendHandlerReady() {
  return typeof xiaomiVoiceSendHandler === 'function'
}

/**
 * @param {string} text
 * @param {{ global?: boolean, xiaomi?: boolean, meeting?: boolean }} [opts]
 */
export async function sendVoiceTranscript(text, opts = {}) {
  const useXiaomi = opts?.xiaomi === true || preferXiaomiVoice
  const useMeeting =
    !useXiaomi && (opts?.meeting === true || preferMeetingVoice) && typeof meetingVoiceSendHandler === 'function'
  const handler = useXiaomi
    ? xiaomiVoiceSendHandler
    : useMeeting
      ? meetingVoiceSendHandler
      : voiceSendHandler
  if (!handler) {
    if (useXiaomi) throw new Error('小V尚未就绪，请稍候再试')
    if (useMeeting) throw new Error('会议室尚未就绪，请稍候再试')
    throw new Error('ChatApp 尚未就绪，请稍候再试')
  }
  if (isSending) {
    console.warn('[background-voice-bridge] 检测到重复发送请求，已拒绝！')
    return
  }
  isSending = true
  try {
    await handler(String(text || '').trim(), {
      ...opts,
      xiaomi: useXiaomi,
      meeting: useMeeting,
    })
  } finally {
    isSending = false
  }
}
