/**
 * Xiaomi Frame-runtime voice provider prefs (localStorage).
 *
 * 音色必须跨分句固定：Frame start 始终带 speaker，避免空 speaker
 * 时各句落到不同 Gateway 默认 / 缓存路径，听起来像换人。
 *
 * 重要：ASR/TTS 通道与音色必须匹配厂商。
 * - 火山/豆包方舟 → OpenSpeech speaker（*_uranus_bigtts 等）
 * - 阿里云 → Qwen-Audio / CosyVoice voice（longanlingxin 等）
 * 混用会导致火山 55000000 / 401，或阿里云 InvalidParameter。
 */

const ASR_KEY = 'evoflow.xiaomi.asr.provider'
const TTS_KEY = 'evoflow.xiaomi.tts.provider'
const SPEAKER_KEY = 'evoflow.xiaomi.tts.speaker'

/** 火山 / 豆包方舟默认音色（seed-tts-2.0） */
export const XIAOMI_DEFAULT_TTS_SPEAKER = 'zh_female_vv_uranus_bigtts'
/** 阿里云 Token Plan / DashScope 默认音色（qwen-audio-3.0-tts-plus） */
export const XIAOMI_DEFAULT_DASHSCOPE_SPEAKER = 'longanlingxin'

const VOLC_TTS_PROVIDERS = new Set(['volcengine', 'doubao'])

export function getXiaomiAsrProvider() {
  try {
    return localStorage.getItem(ASR_KEY) || 'volcengine'
  } catch {
    return 'volcengine'
  }
}

/**
 * 仅配了阿里云语音、未配火山时：把小V 默认火山通道自动切到阿里云。
 * 避免「面板在测阿里云，实际仍打 OpenSpeech → Invalid X-Api-Key / 听成豆包」。
 * @param {{ dashscopeKey?: string, dashscopeTtsEnabled?: boolean, volcSpeechKey?: string, volcTtsEnabled?: boolean }} creds
 * @returns {{ asr: string, tts: string, switched: boolean }}
 */
export function preferDashscopeWhenVolcMissing(creds = {}) {
  const dsKey = String(creds.dashscopeKey || '').trim()
  const volcKey = String(creds.volcSpeechKey || '').trim()
  const dsOn = creds.dashscopeTtsEnabled !== false
  const volcOn = !!creds.volcTtsEnabled
  const canDs = !!(dsKey && dsOn)
  const canVolc = !!(volcKey && volcOn)
  let asr = getXiaomiAsrProvider()
  let tts = getXiaomiTtsProvider()
  let switched = false
  if (canDs && !canVolc) {
    if (asr === 'volcengine') {
      setXiaomiAsrProvider('dashscope')
      asr = 'dashscope'
      switched = true
    }
    if (tts === 'volcengine' || tts === 'doubao') {
      setXiaomiTtsProvider('dashscope', { resetSpeaker: true })
      tts = 'dashscope'
      switched = true
    }
  }
  return { asr, tts, switched }
}

export function setXiaomiAsrProvider(id) {
  try {
    localStorage.setItem(ASR_KEY, String(id || 'volcengine'))
  } catch {
    /* ignore */
  }
}

export function getXiaomiTtsProvider() {
  try {
    return localStorage.getItem(TTS_KEY) || 'volcengine'
  } catch {
    return 'volcengine'
  }
}

/**
 * @param {string} id
 * @param {{ resetSpeaker?: boolean }} [opts]
 */
export function setXiaomiTtsProvider(id, opts = {}) {
  const next = String(id || 'volcengine').trim() || 'volcengine'
  const prev = getXiaomiTtsProvider()
  try {
    localStorage.setItem(TTS_KEY, next)
  } catch {
    /* ignore */
  }
  // 换厂商时清掉旧音色，避免把火山 speaker 送给阿里云（或反过来）
  const reset = opts.resetSpeaker !== false
  if (reset && prev !== next) {
    const prevFam = VOLC_TTS_PROVIDERS.has(prev) ? 'volc' : prev
    const nextFam = VOLC_TTS_PROVIDERS.has(next) ? 'volc' : next
    if (prevFam !== nextFam) {
      setXiaomiTtsSpeaker('')
    }
  }
}

export function getXiaomiTtsSpeaker() {
  try {
    const local = localStorage.getItem(SPEAKER_KEY) || ''
    if (local) return local
  } catch {
    /* ignore */
  }
  return ''
}

export function defaultSpeakerForTtsProvider(provider) {
  const p = String(provider || getXiaomiTtsProvider() || 'volcengine').trim().toLowerCase()
  if (p === 'dashscope') return XIAOMI_DEFAULT_DASHSCOPE_SPEAKER
  if (p === 'openai') return 'nova'
  if (p === 'elevenlabs') return '21m00Tcm4TlvDq8ikWAM'
  if (p === 'minimax') return 'male-qn-qingse'
  // volcengine / doubao — 同一条 OpenSpeech 路
  return XIAOMI_DEFAULT_TTS_SPEAKER
}

function _looksLikeVolcSpeaker(speaker) {
  const sid = String(speaker || '').trim().toLowerCase()
  if (!sid) return false
  if (
    sid.startsWith('longxiao') ||
    sid.startsWith('longcheng') ||
    sid.startsWith('longze') ||
    sid.startsWith('longmiao') ||
    sid.startsWith('longan') ||
    sid.startsWith('longying') ||
    sid.startsWith('longhua') ||
    sid.startsWith('longsan') ||
    sid.startsWith('longshu')
  ) {
    return false
  }
  return (
    sid.includes('_uranus_') ||
    sid.endsWith('_bigtts') ||
    sid.startsWith('icl_') ||
    sid.startsWith('saturn_') ||
    sid.startsWith('s_')
  )
}

function _looksLikeDashscopeSpeaker(speaker) {
  const sid = String(speaker || '').trim().toLowerCase()
  if (!sid) return false
  return (
    sid.startsWith('long') ||
    sid.includes('cosyvoice') ||
    sid.startsWith('qwen-audio')
  )
}

/**
 * Frame / 播报用的固定音色。永不返回空，保证同会话多句同一 speaker id。
 * 按当前 TTS 通道选默认值，并丢弃跨厂商残留音色。
 * @returns {string}
 */
export function resolveXiaomiTtsSpeaker() {
  const provider = getXiaomiTtsProvider()
  const raw = String(getXiaomiTtsSpeaker() || '').trim()
  const fallback = defaultSpeakerForTtsProvider(provider)

  if (!raw) return fallback

  if (VOLC_TTS_PROVIDERS.has(provider)) {
    if (_looksLikeDashscopeSpeaker(raw) && !_looksLikeVolcSpeaker(raw)) {
      return fallback
    }
    return raw
  }
  if (provider === 'dashscope') {
    if (_looksLikeVolcSpeaker(raw)) return fallback
    return raw
  }
  return raw || fallback
}

export function setXiaomiTtsSpeaker(id) {
  try {
    if (id) localStorage.setItem(SPEAKER_KEY, String(id))
    else localStorage.removeItem(SPEAKER_KEY)
  } catch {
    /* ignore */
  }
}

/** 设置页 / 诊断用短标签 */
export function labelXiaomiAsrProvider(id) {
  const p = String(id || getXiaomiAsrProvider()).trim().toLowerCase()
  if (p === 'dashscope') return '阿里云 Paraformer'
  if (p === 'whisper') return '本地 Whisper'
  return '火山引擎'
}

export function labelXiaomiTtsProvider(id) {
  const p = String(id || getXiaomiTtsProvider()).trim().toLowerCase()
  if (p === 'dashscope') return '阿里云语音'
  if (p === 'doubao') return '火山方舟（与火山同一 OpenSpeech 口）'
  if (p === 'openai') return 'OpenAI TTS'
  if (p === 'elevenlabs') return 'ElevenLabs'
  if (p === 'minimax') return 'MiniMax'
  return '火山引擎'
}
