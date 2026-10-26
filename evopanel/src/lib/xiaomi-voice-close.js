/**
 * 小V 语音「关闭 / 退出」统一入口。
 *
 * 手动点「退出」与口令「停止 / 关闭 / 退出」走同一条路径：
 * 停播报 + 退全屏 + 停 Frame/continuous，不把口令发给 AI。
 */

import { isStopTtsOnlyCommand } from './voice-listen-control.js'

/** 直接关掉语音舞台（不跟 AI 交互） */
const EXIT_PHRASES = [
  '停止',
  '停下',
  '关闭',
  '关掉',
  '关了',
  '退出',
  '退出语音',
  '退出小V',
  '结束',
  '结束对话',
  '先这样',
  '没事了',
  '够了',
  '闭嘴',
  '你可以歇了',
  '别说了',
  '不要再说了',
]

function normalizeZh(text) {
  return String(text || '')
    .replace(/[\s\u3000，,。.！!？?、·\-_/\\'"`~]+/g, '')
    .toLowerCase()
}

/**
 * 口令是否表示「关掉语音客户端」（全屏退出），而非仅停播报。
 * 「停止播报」等仍走 TTS-only，不进这里。
 * @param {string} text
 * @returns {boolean}
 */
export function isXiaomiVoiceExitCommand(text) {
  if (isStopTtsOnlyCommand(text)) return false
  const n = normalizeZh(text)
  if (!n) return false
  // 避免长任务句里夹「停止」被误伤
  if (n.length > 12) return false
  for (const phrase of EXIT_PHRASES) {
    const p = normalizeZh(phrase)
    if (!p) continue
    if (n === p || n === `请${p}` || n === `${p}吧` || n === `${p}啊` || n === `${p}啦`) {
      return true
    }
  }
  return false
}

/**
 * 关闭小V语音舞台（与右上角「退出」按钮同一效果）。
 * @param {{ reason?: 'voice' | 'button' | 'esc' | 'program' }} [opts]
 * @returns {Promise<'closed' | 'noop'>}
 */
export async function closeXiaomiVoice(opts = {}) {
  const reason = String(opts.reason || 'program')
  try {
    const { voiceFeLog } = await import('./xiaomi-voice/voice-file-log.js')
    voiceFeLog('退出', `closeXiaomiVoice reason=${reason}`)
  } catch {
    /* ignore */
  }

  try {
    const { isXwVoiceMode, exitXwVoiceMode } = await import('./xw-voice-mode.js')
    if (isXwVoiceMode()) {
      exitXwVoiceMode()
      return 'closed'
    }
  } catch {
    /* ignore */
  }

  // 未在全屏：仍停播报 + 监听，避免口令落空
  try {
    const { shutdownXiaomiVoiceRuntime } = await import('./background-voice.js')
    await shutdownXiaomiVoiceRuntime?.()
  } catch {
    try {
      const { pauseConversationListening } = await import('./background-voice.js')
      await pauseConversationListening({ reason: 'voice', silent: true })
    } catch {
      /* ignore */
    }
  }
  return 'closed'
}
