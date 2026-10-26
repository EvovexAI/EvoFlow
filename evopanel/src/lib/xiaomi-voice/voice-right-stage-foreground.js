/**
 * 小V语音全屏时：platform ui.show / right_stage / chat_artifacts 应走前台右栏，
 * 与主对话同一套 applyStageSetPayload / syncRemoteStageSet，勿当后台会话冻进 memory。
 */

import { getState } from '../../components/global-assistant/assistant-store.js'
import { isXwVoiceMode } from '../xw-voice-mode.js'

/**
 * @param {string | null | undefined} eventSessionKey
 * @returns {boolean}
 */
export function isXiaomiVoiceRightStageForeground(eventSessionKey) {
  if (!isXwVoiceMode()) return false
  const sk = String(eventSessionKey || '').trim()
  if (!sk) return false
  const mine = String(getState()?.sessionKey || '').trim()
  return Boolean(mine && mine === sk)
}
