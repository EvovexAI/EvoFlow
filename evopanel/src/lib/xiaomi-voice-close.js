/**
 * 小V 语音「关闭 / 退出」统一入口。
 *
 * 口令「停止 / 关闭 / 退出」与按钮「退出」：
 * 1. 若本轮仍在生成 → stopXiaomiChat（chatAbort / stopExecution）
 * 2. 停本地/Frame 播报
 * 3. 口令退出时播固定缓存退下语（不调语音模型）
 * 4. 退全屏 + 停 continuous / Frame
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
  '取消',
  '取消任务',
  'stop',
  'exit',
  'cancel',
  'quit',
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
 * Frame / continuous 共用：本地口令闸（不经模型）。
 * - 退出/停止类 → 中断任务 + 停播 + 关语音舞台
 * - 仅停播报 → 停 TTS，继续听
 * @param {string} text
 * @param {{ source?: string }} [opts]
 * @returns {Promise<'exited' | 'tts_stopped' | 'none'>}
 */
export async function tryHandleXiaomiVoiceLocalCommand(text, opts = {}) {
  const cleaned = String(text || '').trim()
  if (!cleaned) return 'none'
  const source = String(opts.source || 'local-command')

  if (isXiaomiVoiceExitCommand(cleaned)) {
    try {
      const { voiceFeLog } = await import('./xiaomi-voice/voice-file-log.js')
      voiceFeLog(
        '打断',
        `本地口令退出（不经模型）source=${source}：「${cleaned.slice(0, 40)}」`,
      )
    } catch {
      /* ignore */
    }
    await closeXiaomiVoice({ reason: 'voice' })
    try {
      const { toast } = await import('../components/toast.js')
      toast('已退出语音', 'info')
    } catch {
      /* ignore */
    }
    return 'exited'
  }

  if (isStopTtsOnlyCommand(cleaned)) {
    try {
      const { voiceFeLog } = await import('./xiaomi-voice/voice-file-log.js')
      voiceFeLog('打断', `本地口令停播报 source=${source}：「${cleaned.slice(0, 40)}」`)
    } catch {
      /* ignore */
    }
    try {
      const { stopAllAssistantSpeech } = await import('./speech-client.js')
      stopAllAssistantSpeech({ reason: 'user-stop-tts', forceFrame: true })
    } catch {
      /* ignore */
    }
    try {
      const { stopXiaomiFrameLocalPlayback } = await import('./xiaomi-voice/index.js')
      stopXiaomiFrameLocalPlayback?.({ reason: 'user-stop-tts' })
    } catch {
      /* ignore */
    }
    try {
      const { toast } = await import('../components/toast.js')
      toast('已停止播报', 'info')
    } catch {
      /* ignore */
    }
    return 'tts_stopped'
  }

  return 'none'
}

/**
 * 停掉当前小V 任务（后端 abort）+ 本地/Frame 播报。
 * @returns {Promise<boolean>} 是否曾尝试 abort（有 session）
 */
async function _stopActiveXiaomiTask() {
  let aborted = false
  try {
    const { getState } = await import('../components/global-assistant/assistant-store.js')
    const streaming = !!getState?.()?.streaming
    const { stopXiaomiChat } = await import('../components/global-assistant/assistant-session.js')
    if (streaming || getState?.()?.sessionKey) {
      await stopXiaomiChat()
      aborted = true
    }
  } catch (e) {
    console.warn('[xiaomi-voice-close] stopXiaomiChat failed', e?.message || e)
  }

  try {
    const { stopAllAssistantSpeech } = await import('./speech-client.js')
    stopAllAssistantSpeech({ reason: 'voice-exit' })
  } catch {
    /* ignore */
  }

  try {
    const {
      interruptXiaomiFrame,
      stopXiaomiFrameLocalPlayback,
      isXiaomiFrameSessionActive,
      isXiaomiFramePipelineActive,
    } = await import('./xiaomi-voice/index.js')
    if (isXiaomiFrameSessionActive?.() || isXiaomiFramePipelineActive?.()) {
      try {
        stopXiaomiFrameLocalPlayback?.({ reason: 'voice-exit' })
      } catch {
        /* ignore */
      }
      try {
        await interruptXiaomiFrame?.()
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }

  return aborted
}

/**
 * 播固定缓存退下语（IndexedDB；不走 Frame / 语音模型）。
 */
async function _playExitFarewell() {
  try {
    const { playFixedVoiceSfx, VOICE_FAREWELL_LINE } = await import('./voice-fixed-sfx.js')
    const { voiceFeLog } = await import('./xiaomi-voice/voice-file-log.js')
    voiceFeLog('退出', `播固定退下语「${VOICE_FAREWELL_LINE}」`)
    await playFixedVoiceSfx(VOICE_FAREWELL_LINE)
  } catch (e) {
    console.warn('[xiaomi-voice-close] farewell sfx failed', e?.message || e)
  }
}

/**
 * 关闭小V语音舞台。
 * @param {{
 *   reason?: 'voice' | 'button' | 'esc' | 'program',
 *   farewell?: boolean,
 * }} [opts]
 *   farewell: 默认口令退出播退下语；按钮/Esc 默认不播（可显式 true）
 * @returns {Promise<'closed' | 'noop'>}
 */
export async function closeXiaomiVoice(opts = {}) {
  const reason = String(opts.reason || 'program')
  const playFarewell = opts.farewell != null ? !!opts.farewell : reason === 'voice'

  // 关面板 = 退出整套语音；闸门日志固定「关闭退出」→ 收尾「已经退出」
  try {
    const { noteVoiceModeGate, voiceFeLog } = await import('./xiaomi-voice/voice-file-log.js')
    noteVoiceModeGate('closing', {
      source: 'closeXiaomiVoice',
      reason,
      message: `farewell=${playFarewell}`,
    })
    voiceFeLog('退出', `closeXiaomiVoice reason=${reason} farewell=${playFarewell}`)
  } catch {
    /* ignore */
  }

  // 1) 停任务 + 停播报（在拆 UI 之前，session 还在）
  const aborted = await _stopActiveXiaomiTask()
  try {
    const { voiceFeLog } = await import('./xiaomi-voice/voice-file-log.js')
    voiceFeLog('退出', aborted ? '已请求后端停止本轮任务' : '无进行中任务 / 已停播报')
  } catch {
    /* ignore */
  }

  // 先停常听，避免退下语被 ASR/barge 打断；UI 稍后再关，好播完固定句
  try {
    const { pauseConversationListening } = await import('./background-voice.js')
    await pauseConversationListening({ reason: 'exit-xw-voice', silent: true })
  } catch {
    /* ignore */
  }

  // 2) 固定话术退下（缓存音效，不调语音模型）
  if (playFarewell) {
    await _playExitFarewell()
  }

  // 3) 退全屏 / 再兜底停 runtime
  try {
    const { isXwVoiceMode, exitXwVoiceMode } = await import('./xw-voice-mode.js')
    if (isXwVoiceMode()) {
      exitXwVoiceMode()
      return 'closed'
    }
  } catch {
    /* ignore */
  }

  try {
    const { shutdownXiaomiVoiceRuntime } = await import('./background-voice.js')
    await shutdownXiaomiVoiceRuntime?.()
  } catch {
    /* ignore */
  }
  return 'closed'
}
