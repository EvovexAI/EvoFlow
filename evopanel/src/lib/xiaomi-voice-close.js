/**
 * 小V 语音「关闭 / 退出」统一入口。
 *
 * 口令「停止 / 关闭 / 退出」与按钮「退出」：
 * 1. 若本轮仍在生成 → stopXiaomiChat（chatAbort / stopExecution）
 * 2. 停本地/Frame 播报
 * 3. 口令退出时播固定缓存「好的，我们下次再聊」（IndexedDB，不调语音模型）
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
  '没事儿了',
  '什么好了', // ASR 常把「没事了」听成这个
  '没啥事了',
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

/** 允许作为「长句尾巴」命中的短口令（ASR 回声 + 用户说停止） */
const EXIT_TRAILING_OK = new Set(
  ['停止', '停下', '退出', '关闭', '关掉', '关了', '闭嘴', '够了', '取消', '没事了', '没事儿了', '什么好了', '没啥事了', '先这样', '结束', 'stop', 'exit', 'cancel', 'quit'].map(
    (p) => p.replace(/[\s\u3000，,。.！!？?、·\-_/\\'"`~]+/g, '').toLowerCase(),
  ),
)

function normalizeZh(text) {
  return String(text || '')
    .replace(/[\s\u3000，,。.！!？?、·\-_/\\'"`~]+/g, '')
    .toLowerCase()
}

function _matchesExitPhrase(n, p) {
  if (!p) return false
  return n === p || n === `请${p}` || n === `${p}吧` || n === `${p}啊` || n === `${p}啦`
}

/**
 * 口令是否表示「关掉语音客户端」（全屏退出），而非仅停播报。
 * 「停止播报」等仍走 TTS-only，不进这里。
 *
 * 短句精确匹配；长句仅当尾巴是短退出口令（播报回声 +「停止」），
 * 且尾巴前不是「不要/别」否定。
 * @param {string} text
 * @returns {boolean}
 */
export function isXiaomiVoiceExitCommand(text) {
  if (isStopTtsOnlyCommand(text)) return false
  const n = normalizeZh(text)
  if (!n) return false

  // 1) 短句精确
  if (n.length <= 14) {
    for (const phrase of EXIT_PHRASES) {
      if (_matchesExitPhrase(n, normalizeZh(phrase))) return true
    }
  }

  // 2) 长句尾巴：……停止 / ……。停止（安装包日志：回声正文 + 用户说停止仍被送进模型）
  for (const phrase of EXIT_PHRASES) {
    const p = normalizeZh(phrase)
    if (!p || !EXIT_TRAILING_OK.has(p)) continue
    if (!n.endsWith(p) && !n.endsWith(`请${p}`)) continue
    const head = n.endsWith(`请${p}`) ? n.slice(0, -p.length - 1) : n.slice(0, -p.length)
    if (!head) return true
    // 「不要停止 / 别停止 / 先别停」不当退出
    if (/(不要|别再|别|先别|不用|别给我)$/.test(head)) continue
    // 尾巴必须是短口令本身（防止「停止下载」类任务句）
    return true
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
    await _playStoppedAck()
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
 * 播固定缓存「好的，我们下次再聊」（IndexedDB；不走 Frame / 语音模型）。
 * 口令停止 / 退出后友好确认；首播合成一次，之后本地复用。
 */
async function _playStoppedAck() {
  try {
    const { playFixedVoiceSfx, VOICE_STOPPED_LINE } = await import('./voice-fixed-sfx.js')
    const { voiceFeLog } = await import('./xiaomi-voice/voice-file-log.js')
    voiceFeLog('退出', `播固定停止确认「${VOICE_STOPPED_LINE}」`)
    await playFixedVoiceSfx(VOICE_STOPPED_LINE)
  } catch (e) {
    console.warn('[xiaomi-voice-close] stopped ack sfx failed', e?.message || e)
  }
}

/**
 * 关闭小V语音舞台。
 * @param {{
 *   reason?: 'voice' | 'button' | 'esc' | 'program',
 *   farewell?: boolean,
 * }} [opts]
 *   farewell: 兼容旧参数；口令退出默认播「好的，已停止」；按钮/Esc 默认不播（可显式 true）
 * @returns {Promise<'closed' | 'noop'>}
 */
export async function closeXiaomiVoice(opts = {}) {
  const reason = String(opts.reason || 'program')
  // 口令「停止/退出」→ 播「好的，我们下次再聊」；按钮关面板默认静默
  const playStoppedAck = opts.farewell != null ? !!opts.farewell : reason === 'voice'

  // 关面板 = 退出整套语音；闸门日志固定「关闭退出」→ 收尾「已经退出」
  try {
    const { noteVoiceModeGate, voiceFeLog } = await import('./xiaomi-voice/voice-file-log.js')
    noteVoiceModeGate('closing', {
      source: 'closeXiaomiVoice',
      reason,
      message: `stoppedAck=${playStoppedAck}`,
    })
    voiceFeLog('退出', `closeXiaomiVoice reason=${reason} stoppedAck=${playStoppedAck}`)
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

  // 先停常听，避免确认句被 ASR/barge 打断；UI 稍后再关，好播完固定句
  try {
    const { pauseConversationListening } = await import('./background-voice.js')
    await pauseConversationListening({ reason: 'exit-xw-voice', silent: true })
  } catch {
    /* ignore */
  }

  // 2) 固定话术确认已停止（缓存音效，不调语音模型）
  if (playStoppedAck) {
    await _playStoppedAck()
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
