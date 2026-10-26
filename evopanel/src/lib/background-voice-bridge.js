/**
 * 后台语音发消息桥接。
 * - 主对话：ChatApp 挂载时注册 voiceSendHandler
 * - 「小V小V」唤醒：走全局小V面板（xiaomiVoiceSendHandler）
 * 持续监听模式下，partial 文字也通过此桥接实时推到 ChatComposer / 小V面板。
 */

import { isXwVoiceMode } from './xw-voice-mode.js'
import { noteVoicePanelDisplay, noteVoicePanelSend } from './xiaomi-voice/voice-file-log.js'

/** @type {((text: string, opts?: { global?: boolean, xiaomi?: boolean }) => void | Promise<void>) | null} */
let voiceSendHandler = null
/** @type {((text: string, opts?: { global?: boolean, xiaomi?: boolean }) => void | Promise<void>) | null} */
let xiaomiVoiceSendHandler = null
/** 防重锁：chatSend 整轮 await 期间为 true（可能长达数十秒） */
let isSending = false
/**
 * 常听下一句排队：chatSend 未结束时不能丢弃（旧逻辑直接 return → 转写已清、界面卡「处理中」）。
 * 只保留最新一句（白龙马式一轮一发，后话覆盖前话）。
 * @type {{ text: string, opts: Record<string, unknown> } | null}
 */
let _pendingVoiceSend = null

// ─── 持续模式 / 全局 PTT partial 文字显示桥接 ───
/** @type {((text: string) => void) | null} */
let voicePartialHandler = null
/** @type {((text: string) => void) | null} */
let xiaomiVoicePartialHandler = null
/** @type {Set<(text: string) => void>} 语音全屏等额外订阅（不替换主 handler） */
const xiaomiVoicePartialListeners = new Set()
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

/**
 * 额外订阅小V ASR partial（语音全屏左侧「你」实时区）。
 * @param {(text: string) => void} fn
 * @returns {() => void}
 */
export function subscribeXiaomiVoicePartial(fn) {
  if (typeof fn !== 'function') return () => {}
  xiaomiVoicePartialListeners.add(fn)
  return () => {
    xiaomiVoicePartialListeners.delete(fn)
  }
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
  // 已退出语音全屏且未 prefer 小V/会议室：丢弃迟到 ASR，禁止再灌主输入框
  if (!preferXiaomiVoice && !preferMeetingVoice && !isXwVoiceMode()) {
    if (t.trim()) return
  }
  // 与面板显示同步落盘：上屏字 + 上屏时间（发送时间在 noteVoicePanelSend）
  noteVoicePanelDisplay(t, {
    source: preferXiaomiVoice ? '小V面板' : preferMeetingVoice ? '会议室' : '输入框',
  })
  // 会议室打开时优先（唤醒小V 仍可抢占）
  if (!preferXiaomiVoice && preferMeetingVoice && typeof meetingVoicePartialHandler === 'function') {
    meetingVoicePartialHandler(t)
    return
  }
  if (preferXiaomiVoice) {
    if (typeof xiaomiVoicePartialHandler === 'function') {
      xiaomiVoicePartialHandler(t)
    }
    // 语音全屏等：必须同步推，不能只靠 silent patchState（订阅收不到）
    for (const fn of xiaomiVoicePartialListeners) {
      try {
        fn(t)
      } catch {
        /* ignore */
      }
    }
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
  // 已退出语音全屏：拒绝迟到发送（避免面板关了还往外发）
  if (!preferXiaomiVoice && !preferMeetingVoice && !isXwVoiceMode() && opts?.xiaomi !== true && opts?.meeting !== true) {
    console.warn('[xiaomi-voice] sendVoiceTranscript ignored — voice UI exited')
    try {
      const { voiceFeLog } = await import('./xiaomi-voice/voice-file-log.js')
      voiceFeLog('会话', `已退出语音 → 丢弃迟到发送：「${String(text || '').trim().slice(0, 40)}」`)
    } catch {
      /* ignore */
    }
    return
  }
  // 小V Frame 管线活跃时强制走小V，禁止再进主对话输入框路径（双发根因之一）
  let frameActive = false
  try {
    const { isXiaomiFramePipelineActive } = await import('./xiaomi-voice/index.js')
    frameActive = !!isXiaomiFramePipelineActive?.()
  } catch {
    frameActive = false
  }
  const useXiaomi = opts?.xiaomi === true || preferXiaomiVoice || frameActive
  const useMeeting =
    !useXiaomi && (opts?.meeting === true || preferMeetingVoice) && typeof meetingVoiceSendHandler === 'function'
  // 主对话不再承接麦克风转写：无小V/会议室时直接拒绝，避免误发到 ChatComposer
  const handler = useXiaomi
    ? xiaomiVoiceSendHandler
    : useMeeting
      ? meetingVoiceSendHandler
      : null
  const preview = String(text || '').trim().slice(0, 40)
  console.info(
    '[xiaomi-voice] sendVoiceTranscript',
    {
      useXiaomi,
      useMeeting,
      preferXiaomiVoice,
      frameActive,
      hasXiaomiHandler: typeof xiaomiVoiceSendHandler === 'function',
      hasMainHandler: typeof voiceSendHandler === 'function',
      textLen: String(text || '').trim().length,
    },
    JSON.stringify(preview),
  )
  if (!handler) {
    if (useXiaomi) throw new Error('小V尚未就绪，请稍候再试')
    if (useMeeting) throw new Error('会议室尚未就绪，请稍候再试')
    throw new Error('语音输入仅支持小V，请先唤醒小V')
  }
  const payload = String(text || '').trim()
  if (!payload) return

  // 上一轮 chatSend 仍在飞：排队最新一句，绝不静默丢弃（多轮卡死根因）
  if (isSending) {
    _pendingVoiceSend = { text: payload, opts: { ...opts } }
    console.warn('[background-voice-bridge] 发送中 → 排队最新一句 len=', payload.length)
    try {
      const { voiceFeLog } = await import('./xiaomi-voice/voice-file-log.js')
      voiceFeLog('会话', `发送中 → 排队最新一句：「${payload.slice(0, 40)}」`)
    } catch {
      /* ignore */
    }
    return
  }

  isSending = true
  try {
    // 小V 发问由 sendXiaomiChat 统一记「发送」；此处只记会议室等其它路径，避免双行
    if (!useXiaomi) {
      noteVoicePanelSend(payload, {
        source: useMeeting ? '会议室' : '语音',
        detail: `voiceTranscript len=${payload.length}`,
      })
    }
    await handler(payload, {
      ...opts,
      xiaomi: useXiaomi,
      meeting: useMeeting,
    })
  } finally {
    isSending = false
    const next = _pendingVoiceSend
    _pendingVoiceSend = null
    if (next?.text) {
      void sendVoiceTranscript(next.text, next.opts || {})
    }
  }
}

/** 常听策略：上一轮仍在飞时先别 fireSend（等排队槽或 finally 冲刷） */
export function isVoiceSendBusy() {
  return !!isSending
}

/** 退出语音时丢掉排队句，避免关掉后又发出去 */
export function clearPendingVoiceSend() {
  _pendingVoiceSend = null
}
