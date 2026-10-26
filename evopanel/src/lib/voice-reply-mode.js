/**
 * 语音播报：开 / 关。
 * 开：每次助手回复都朗读；关：不自动朗读。与是否语音提问无关。
 */

const LS_VOICE_REPLY_USER_EXPLICIT = 'evoflow.voiceReplyUserExplicit'

/**
 * 用户是否在 UI 里显式开关过「语音播报」（用于区分旧版小V ensure 误持久打开）。
 * @returns {boolean}
 */
export function isVoiceReplyUserExplicit() {
  try {
    return localStorage.getItem(LS_VOICE_REPLY_USER_EXPLICIT) === '1'
  } catch {
    return false
  }
}

/**
 * 标记用户手动开关过「语音播报」。
 */
export function markVoiceReplyUserExplicit() {
  try {
    localStorage.setItem(LS_VOICE_REPLY_USER_EXPLICIT, '1')
  } catch {
    /* ignore */
  }
}

/**
 * @param {unknown} rawMode
 * @param {unknown} [legacyEnabled]
 * @returns {boolean}
 */
export function isVoiceReplyEnabled(rawMode, legacyEnabled) {
  const m = String(rawMode || '').trim().toLowerCase()
  if (m === 'off') return false
  if (m === 'voice_only' || m === 'always' || m === 'on') return true
  if (legacyEnabled === false || legacyEnabled === 0 || legacyEnabled === '0' || legacyEnabled === 'false') {
    return false
  }
  if (legacyEnabled === true || legacyEnabled === 1 || legacyEnabled === '1' || legacyEnabled === 'true') {
    return true
  }
  // 默认关
  return false
}

/**
 * 主对话是否应 arm TTS。
 * 仅认「用户在 UI 显式开过」的开关；旧版小V ensure 误持久的开不算
 * （语音提问仍靠 voiceInitiated 单独 arm）。
 * @param {boolean} enabled
 */
export function shouldArmVoiceReply(enabled) {
  if (!enabled) return false
  return isVoiceReplyUserExplicit()
}

/**
 * 清掉「非用户显式」却仍为开的语音播报（旧版进小V 误持久）。
 * @returns {Promise<boolean>} 是否改写了设置
 */
export async function scrubNonExplicitVoiceReplyEnabled() {
  try {
    const { getVoiceReplyEnabled, patchPanelSettings } = await import('./panel-settings.js')
    if (!getVoiceReplyEnabled()) return false
    if (isVoiceReplyUserExplicit()) return false
    await patchPanelSettings(voiceReplyModeToSettingsPatch(false))
    return true
  } catch {
    return false
  }
}

/**
 * @param {boolean} enabled
 */
export function voiceReplyModeToSettingsPatch(enabled) {
  const on = !!enabled
  return {
    voiceReplyEnabledDefault: on,
    // 兼容旧字段：开→always（每轮播），关→off
    voiceReplyMode: on ? 'always' : 'off',
  }
}
