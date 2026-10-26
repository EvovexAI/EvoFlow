/**
 * 小V 语音会话默认：唤醒 / 打开语音全屏时打开「语音播报」，
 * 并标记 preferXiaomiVoice，让 ASR 结果走小V 而不是主对话。
 *
 * 语音转换在哪：
 * - ASR（你说 → 字）：前台采麦 → Gateway `/api/speech/asr*` → 火山识别（后台）
 * - TTS（字 → 播报）：前台拿到助手正文 → Gateway `POST /api/speech/tts` → 火山合成（后台）→ 前台 Audio 播放
 *
 * 诊断日志：过滤控制台 `[xiaomi-voice]`。
 * 更细 TTS 队列：localStorage.setItem('EVOFLOW_DEBUG_SPEECH','1')
 * 流式同步明细：localStorage.setItem('EVOFLOW_DEBUG_XIAOMI_VOICE','1')
 */
import { setPreferXiaomiVoice, isPreferXiaomiVoice } from './background-voice-bridge.js'
import { isDebugOn } from './debug-flag.js'

/** 里程碑日志（默认开，方便排查「唤醒后不播」） */
export function xiaomiVoiceLog(...args) {
  console.info('[xiaomi-voice]', ...args)
}

/** 高频明细（默认关） */
export function xiaomiVoiceDebug(...args) {
  if (!isDebugOn('EVOFLOW_DEBUG_XIAOMI_VOICE')) return
  console.log('[xiaomi-voice:debug]', ...args)
}

/**
 * 音色 id → 可读名（设置页预设；未知则原样返回）。
 * @param {string} speakerId
 */
export function formatTtsSpeakerLabel(speakerId) {
  const id = String(speakerId || '').trim()
  if (!id) return '(Gateway 默认音色)'
  try {
    // sync import 会拉大包；这里用已缓存的 list 若有，否则仅显示 id
    const presets = globalThis.__EVOFLOW_TTS_SPEAKER_PRESETS__
    if (Array.isArray(presets)) {
      const hit = presets.find((p) => p && p.value === id)
      if (hit?.label) return `${hit.label} [${id}]`
    }
  } catch {
    /* ignore */
  }
  return id
}

/** 异步解析音色可读名（含预设表） */
export async function resolveTtsSpeakerLabel(speakerId) {
  const id = String(speakerId || '').trim()
  if (!id) return '(请求未带 speaker → Gateway 用配置默认)'
  try {
    const { VOLCENGINE_TTS_SPEAKER_PRESETS } = await import('./volcengine-tts-speakers.js')
    globalThis.__EVOFLOW_TTS_SPEAKER_PRESETS__ = VOLCENGINE_TTS_SPEAKER_PRESETS
    const hit = VOLCENGINE_TTS_SPEAKER_PRESETS.find((p) => p.value === id)
    if (hit?.label) return `${hit.label} · ${id}`
  } catch {
    /* ignore */
  }
  return id
}

/**
 * 小V 语音回合是否应朗读（设置已开，或正处于语音全屏 / 唤醒优先）。
 * @param {boolean} [settingsEnabled]
 */
export function shouldXiaomiVoiceReply(settingsEnabled) {
  if (settingsEnabled) return true
  try {
    if (isPreferXiaomiVoice()) return true
  } catch {
    /* ignore */
  }
  try {
    if (typeof document !== 'undefined' && document.documentElement?.dataset?.xwVoice === '1') {
      return true
    }
  } catch {
    /* ignore */
  }
  return false
}

/**
 * @returns {{ settingsOn: boolean, prefer: boolean, xwVoice: boolean, speak: boolean }}
 */
export function xiaomiVoiceReplySnapshot(settingsEnabled) {
  let prefer = false
  let xwVoice = false
  try {
    prefer = !!isPreferXiaomiVoice()
  } catch {
    /* ignore */
  }
  try {
    xwVoice = document.documentElement?.dataset?.xwVoice === '1'
  } catch {
    /* ignore */
  }
  const settingsOn = !!settingsEnabled
  return {
    settingsOn,
    prefer,
    xwVoice,
    speak: shouldXiaomiVoiceReply(settingsOn),
  }
}

/**
 * 打开小V 语音主场时调用：prefer 小V +（若语音已配置）打开语音播报开关。
 * @returns {Promise<boolean>} 是否已具备朗读条件（设置开或本回合强制开）
 */
export async function ensureXiaomiVoiceReplyOn() {
  setPreferXiaomiVoice(true)
  xiaomiVoiceLog('ensure: preferXiaomiVoice=true（ASR 将走小V）')

  let speechOk = false
  let speechDetail = {}
  try {
    const { fetchSpeechConfigured, speechConfiguredCached, speechStreamingAsrCached } = await import(
      './speech-client.js',
    )
    speechOk = speechConfiguredCached() === true || (await fetchSpeechConfigured()) === true
    speechDetail = {
      configured: speechOk,
      streamingAsr: speechStreamingAsrCached(),
      note: 'configured=TTS/ASR 凭证是否就绪（Gateway /api/speech/status → 火山）',
    }
  } catch (e) {
    speechDetail = { configured: false, error: String(e?.message || e) }
  }
  xiaomiVoiceLog('ensure: speech status', speechDetail)
  if (!speechOk) {
    console.warn(
      '[xiaomi-voice] ensure: Gateway 报告语音未配置。请到「设置 → 模型」确认火山 TTS/ASR；合成在后台 Gateway，播放在前台。',
    )
  }

  // 当前配置的朗读音色（设置 → 媒体 / 模型里的 volcengineTtsSpeaker）
  try {
    const { getCachedMediaCredentials, fetchMediaCredentials, DEFAULT_MEDIA_CREDENTIALS } =
      await import('./media-settings.js')
    let creds = getCachedMediaCredentials?.()
    if (!creds) {
      try {
        creds = await fetchMediaCredentials()
      } catch {
        creds = null
      }
    }
    const speakerId = String(
      creds?.volcengineTtsSpeaker || DEFAULT_MEDIA_CREDENTIALS?.volcengineTtsSpeaker || '',
    ).trim()
    const label = await resolveTtsSpeakerLabel(speakerId)
    xiaomiVoiceLog('ensure: 配置音色', { speaker: speakerId || '(空)', label })
  } catch (e) {
    xiaomiVoiceLog('ensure: 读音色配置失败', String(e?.message || e))
  }

  try {
    const { getVoiceReplyEnabled, patchPanelSettings } = await import('./panel-settings.js')
    const { voiceReplyModeToSettingsPatch } = await import('./voice-reply-mode.js')
    const before = getVoiceReplyEnabled()
    if (!before) {
      await patchPanelSettings(voiceReplyModeToSettingsPatch(true))
      xiaomiVoiceLog('ensure: 已打开「语音播报」开关 voiceReplyEnabledDefault=true')
    } else {
      xiaomiVoiceLog('ensure: 语音播报开关本来就是开的')
    }
    const snap = xiaomiVoiceReplySnapshot(getVoiceReplyEnabled())
    xiaomiVoiceLog('ensure: speak decision', snap)
  } catch (e) {
    console.warn('[xiaomi-voice] ensure: enable voice reply failed', e?.message || e)
  }

  return speechOk || shouldXiaomiVoiceReply(true)
}
