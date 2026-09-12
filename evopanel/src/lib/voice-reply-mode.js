/**
 * 语音播报：开 / 关。
 * 开：每次助手回复都朗读；关：不自动朗读。与是否语音提问无关。
 */

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
 * @param {boolean} enabled
 */
export function shouldArmVoiceReply(enabled) {
  return !!enabled
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
