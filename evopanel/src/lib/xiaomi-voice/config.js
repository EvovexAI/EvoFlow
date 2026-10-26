/**
 * Xiaomi Frame-runtime voice provider prefs (localStorage).
 */

const ASR_KEY = 'evoflow.xiaomi.asr.provider'
const TTS_KEY = 'evoflow.xiaomi.tts.provider'
const SPEAKER_KEY = 'evoflow.xiaomi.tts.speaker'

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

export function setXiaomiTtsSpeaker(id) {
  try {
    if (id) localStorage.setItem(SPEAKER_KEY, String(id))
    else localStorage.removeItem(SPEAKER_KEY)
  } catch {
    /* ignore */
  }
}
