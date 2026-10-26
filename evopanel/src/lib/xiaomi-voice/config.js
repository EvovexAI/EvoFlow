/**
 * Xiaomi Frame-runtime voice provider prefs (localStorage).
 *
 * 音色必须跨分句固定：Frame start 始终带 speaker，避免空 speaker
 * 时各句落到不同 Gateway 默认 / 缓存路径，听起来像换人。
 */

const ASR_KEY = 'evoflow.xiaomi.asr.provider'
const TTS_KEY = 'evoflow.xiaomi.tts.provider'
const SPEAKER_KEY = 'evoflow.xiaomi.tts.speaker'

/** 与 backend DEFAULT_TTS_SPEAKER / media-settings 默认对齐 */
export const XIAOMI_DEFAULT_TTS_SPEAKER = 'zh_female_vv_uranus_bigtts'

export function getXiaomiAsrProvider() {
  try {
    return localStorage.getItem(ASR_KEY) || 'volcengine'
  } catch {
    return 'volcengine'
  }
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

export function setXiaomiTtsProvider(id) {
  try {
    localStorage.setItem(TTS_KEY, String(id || 'volcengine'))
  } catch {
    /* ignore */
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

/**
 * Frame / 播报用的固定音色。永不返回空，保证同会话多句同一 speaker id。
 * localStorage 由 ensureXiaomiVoiceReplyOn / 设置页写入；未写过则用产品默认。
 * @returns {string}
 */
export function resolveXiaomiTtsSpeaker() {
  return String(getXiaomiTtsSpeaker() || '').trim() || XIAOMI_DEFAULT_TTS_SPEAKER
}

export function setXiaomiTtsSpeaker(id) {
  try {
    if (id) localStorage.setItem(SPEAKER_KEY, String(id))
    else localStorage.removeItem(SPEAKER_KEY)
  } catch {
    /* ignore */
  }
}
