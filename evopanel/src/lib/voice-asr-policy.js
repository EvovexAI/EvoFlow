/**
 * Prefer Volcengine streaming / flash ASR when Gateway speech is configured.
 * Falls back to system Web Speech when Volcengine is unavailable.
 *
 * Set to `false` to force Web Speech only (debug / regression).
 */
export const VOLCENGINE_ASR_ENABLED = true

export function isVolcengineAsrEnabled() {
  return VOLCENGINE_ASR_ENABLED === true
}
