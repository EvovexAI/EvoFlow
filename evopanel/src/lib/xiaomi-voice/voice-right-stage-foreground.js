/**
 * 小V语音全屏时：platform / 浏览器 / 文件应走前台右栏。
 *
 * 右栏 adopt 后 UI sessionKey 是小V。小V 自己开浏览器时，bridge owner /
 * panel-request 仍可能误标成 parked 的 main key → 被当成「后台」冻进记忆，
 * 表现为「右侧没打开」。语音占用期间一律抬当前 UI 右栏。
 */

import { getState } from '../../components/global-assistant/assistant-store.js'
import {
  getParkedChatRightStageSessionKey,
  isXiaomiRightStageSessionAdopted,
} from '../right-stage/xiaomi-right-stage-session.js'
import { getCurrentRightStageSessionKey } from '../right-stage/right-stage-session-memory.js'
import { isXwVoiceMode } from '../xw-voice-mode.js'

/** 语音全屏且右栏已切到小V 会话表。 */
export function isXiaomiVoiceRightStageActive() {
  return isXwVoiceMode() && isXiaomiRightStageSessionAdopted()
}

/**
 * @param {string} sessionKey
 */
function isParkedChatSession(sessionKey) {
  if (!isXiaomiRightStageSessionAdopted()) return false
  const parked = String(getParkedChatRightStageSessionKey() || '').trim()
  return Boolean(parked && parked === sessionKey)
}

/**
 * @param {string | null | undefined} eventSessionKey
 * @returns {boolean}
 */
export function isXiaomiVoiceRightStageForeground(eventSessionKey) {
  if (!isXiaomiVoiceRightStageActive()) return false
  const sk = String(eventSessionKey || '').trim()
  if (!sk) return true
  const mine = String(getState()?.sessionKey || '').trim()
  if (mine && mine === sk) return true
  // wire 误标成 main / parked：仍当前台
  if (isParkedChatSession(sk)) return true
  // 其它非小V key：语音占用下也抬 live（小V 开浏览器常被标成 main）
  return true
}

/**
 * 归属会话 ≠ UI 时，语音占用下仍应抬 live 右栏（而非冻进 memory）。
 * @param {string | null | undefined} _browserSessionKey
 */
export function shouldSurfaceBrowserOnXiaomiVoiceUi(_browserSessionKey) {
  return isXiaomiVoiceRightStageActive()
}

/**
 * panel-request / ensure 用的会话：语音占用时钉到当前 UI（小V），
 * 避免 owner 残留 main 导致 background。
 * @param {string | null | undefined} ownerOrExplicit
 * @returns {string}
 */
export function resolveXiaomiVoiceBrowserSessionKey(ownerOrExplicit) {
  if (!isXiaomiVoiceRightStageActive()) {
    return String(ownerOrExplicit || '').trim()
  }
  const ui = String(getCurrentRightStageSessionKey() || '').trim()
  if (ui) return ui
  const mine = String(getState()?.sessionKey || '').trim()
  return mine || String(ownerOrExplicit || '').trim()
}

/**
 * HWND owner ≠ UI：语音占用下不算 foreign（小V 开的窗也要贴位）。
 * @param {string | null | undefined} ownerSk
 * @param {string | null | undefined} _uiSk
 */
export function isXiaomiVoiceBridgeOwnerAligned(ownerSk, _uiSk) {
  if (!isXiaomiVoiceRightStageActive()) return false
  return Boolean(String(ownerSk || '').trim())
}
