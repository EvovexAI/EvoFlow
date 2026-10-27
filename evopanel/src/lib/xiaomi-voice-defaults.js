/**
 * 小V 语音会话默认：唤醒 / 打开语音全屏时标记 preferXiaomiVoice（ASR→小V），
 * 朗读靠 prefer / xwVoice，不改全局「语音播报」开关（避免退出后主对话误播）。
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
import { isVoiceReplyUserExplicit } from './voice-reply-mode.js'

/** 里程碑日志（默认开，方便排查「唤醒后不播」）；同时写入语音专用日志文件 */
export function xiaomiVoiceLog(...args) {
  console.info('[xiaomi-voice]', ...args)
  try {
    const msg = args
      .map((a) => {
        if (a == null) return ''
        if (typeof a === 'string') return a
        try {
          return JSON.stringify(a)
        } catch {
          return String(a)
        }
      })
      .filter(Boolean)
      .join(' ')
    if (!msg) return
    void import('./xiaomi-voice/voice-file-log.js').then(({ voiceFeLog }) => {
      voiceFeLog('过程', msg)
    })
  } catch {
    /* ignore */
  }
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
 * 进入小V 语音时记下的「语音播报」开关快照；退出时还原，避免泄漏到主对话。
 * null = 本会话未进过 ensure。
 * @type {boolean | null}
 */
let _voiceReplyBaselineOnEnter = null

/**
 * 小V 语音回合是否应朗读：
 * 语音全屏 / prefer 唤醒优先，或用户在 UI 显式开过的「语音播报」。
 * 旧版 ensure 误持久的开关 alone 不够。
 * @param {boolean} [settingsEnabled]
 */
export function shouldXiaomiVoiceReply(settingsEnabled) {
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
  if (settingsEnabled && isVoiceReplyUserExplicit()) return true
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
 * 语音进场：会话 context 强制关思考（与 chatSend voice 硬闸对齐，避免模型慢回）。
 * 失败不阻断进场。
 */
async function ensureXiaomiVoiceThinkingOff() {
  try {
    const { ensureXiaomiSession, XIAOMI_AGENT } = await import(
      '../components/global-assistant/assistant-session.js'
    )
    const { api } = await import('./tauri-api.js')
    // 语音热路径：勿 reloadHistory，只保证 session + context 关思考
    const key = await ensureXiaomiSession({ reloadHistory: false })
    if (!key) return
    await api.chatUpdateContext(key, {
      agent_name: XIAOMI_AGENT,
      agent_id: XIAOMI_AGENT,
      xiaomi_global_assistant: true,
      thinking_enabled: false,
      thinking_type: 'disabled',
      reasoning_effort: 'minimum',
    })
    xiaomiVoiceLog('ensure: thinking_enabled=false（语音快回）')
  } catch (e) {
    console.warn('[xiaomi-voice] ensure thinking off failed', e?.message || e)
  }
}

/**
 * 打开小V 语音主场时调用：prefer 小V（朗读靠 prefer/xwVoice，不持久改全局播报开关）。
 * @returns {Promise<boolean>} 是否已具备朗读条件（设置开或本回合强制开）
 */
export async function ensureXiaomiVoiceReplyOn() {
  setPreferXiaomiVoice(true)
  xiaomiVoiceLog('ensure: preferXiaomiVoice=true（ASR 将走小V）')
  void ensureXiaomiVoiceThinkingOff()

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
    // 先落 speaker（唤醒热路径依赖），label 解析可慢（日志曾卡 ~5s）放到后台
    if (speakerId) {
      const { setXiaomiTtsSpeaker } = await import('./xiaomi-voice/config.js')
      setXiaomiTtsSpeaker(speakerId)
    }
    void resolveTtsSpeakerLabel(speakerId).then((label) => {
      xiaomiVoiceLog('ensure: 配置音色', { speaker: speakerId || '(空)', label })
    })
  } catch (e) {
    xiaomiVoiceLog('ensure: 读音色配置失败', String(e?.message || e))
  }

  // 小V 朗读靠 preferXiaomi + xwVoice（见 shouldXiaomiVoiceReply），
  // 不要把全局「语音播报」永久打开——否则退出后主对话文本轮也会 legacy TTS。
  try {
    const { getVoiceReplyEnabled } = await import('./panel-settings.js')
    const settingsOn = !!getVoiceReplyEnabled()
    if (_voiceReplyBaselineOnEnter == null) {
      _voiceReplyBaselineOnEnter = settingsOn
    }
    const snap = xiaomiVoiceReplySnapshot(settingsOn)
    xiaomiVoiceLog('ensure: speak decision（不改全局开关）', snap)
  } catch (e) {
    console.warn('[xiaomi-voice] ensure: speak snapshot failed', e?.message || e)
  }

  return speechOk || shouldXiaomiVoiceReply(true)
}

/**
 * 退出小V 语音后：还原全局「语音播报」、清 pending、停残留播报。
 * - 有进场快照 → 还原到进场时
 * - 开关开着但用户从未在 UI 显式开过 → 关掉（清掉旧版 ensure 误持久）
 */
export async function restoreXiaomiVoiceReplyAfterExit() {
  try {
    const { getVoiceReplyEnabled, patchPanelSettings } = await import('./panel-settings.js')
    const { voiceReplyModeToSettingsPatch, isVoiceReplyUserExplicit, scrubNonExplicitVoiceReplyEnabled } =
      await import('./voice-reply-mode.js')
    const nowOn = !!getVoiceReplyEnabled()
    let target = nowOn
    if (_voiceReplyBaselineOnEnter != null) {
      target = !!_voiceReplyBaselineOnEnter
      _voiceReplyBaselineOnEnter = null
    }
    // 旧版 ensure 曾把开关写进 settings；用户没显式开过则退出后关掉
    if (target && !isVoiceReplyUserExplicit()) {
      target = false
    }
    if (nowOn !== target) {
      await patchPanelSettings(voiceReplyModeToSettingsPatch(target))
      xiaomiVoiceLog('exit: 还原「语音播报」', { from: nowOn, to: target })
    } else {
      const scrubbed = await scrubNonExplicitVoiceReplyEnabled()
      if (scrubbed) xiaomiVoiceLog('exit: 已清除非用户显式的「语音播报」开')
    }
  } catch (e) {
    console.warn('[xiaomi-voice] restore voice reply setting failed', e?.message || e)
  }

  try {
    const { clearXiaomiVoiceReply } = await import(
      '../components/global-assistant/assistant-session.js'
    )
    clearXiaomiVoiceReply?.()
  } catch {
    /* ignore */
  }

  try {
    const { stopAllAssistantSpeech } = await import('./speech-client.js')
    stopAllAssistantSpeech?.({ reason: 'xiaomi-voice-exit-restore', forceFrame: true })
  } catch {
    /* ignore */
  }
}
