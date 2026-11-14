/**
 * AI 员工聊天室播报场景壳：
 * - mute 键与会议消息 schema 映射
 * - 泵逻辑在 agent-tts-queue（与部门群共用）
 */

import { unlockSpeechPlayback } from './speech-client.js'
import { createAgentTtsQueue } from './agent-tts-queue.js'

const STORAGE_KEY = 'evoflow.meetingTtsMuted'

/** @type {boolean} */
let _muted = true
try {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw === '0') _muted = false
  if (raw === '1') _muted = true
} catch {
  /* ignore */
}

const queue = createAgentTtsQueue({ logTag: 'meeting-tts' })

/**
 * @param {Array<Record<string, unknown>>} meetingMessages
 */
function mapMeetingMessages(meetingMessages) {
  const out = []
  for (const m of Array.isArray(meetingMessages) ? meetingMessages : []) {
    if (m?.role !== 'agent') continue
    out.push({
      id: String(m.id || ''),
      agent_code: String(m.agent_code || '').trim(),
      text: String(m.text || ''),
      completed: m.state === 'completed',
      error: !!m.error,
    })
  }
  return out
}

/** 当前正在 TTS 口播的发言（无则 null） */
export function getMeetingTtsUtterance() {
  return queue.getUtterance()
}

/**
 * @param {(u: { key: string, code: string, text: string } | null) => void} cb
 * @returns {() => void}
 */
export function subscribeMeetingTtsUtterance(cb) {
  return queue.subscribeUtterance(cb)
}

export function isMeetingTtsMuted() {
  return _muted
}

/**
 * @param {boolean} muted
 * @param {{ unlock?: boolean }} [opts]
 */
export function setMeetingTtsMuted(muted, opts = {}) {
  _muted = !!muted
  try {
    localStorage.setItem(STORAGE_KEY, _muted ? '1' : '0')
  } catch {
    /* ignore */
  }
  if (_muted) {
    queue.stop()
  } else if (opts.unlock !== false) {
    void unlockSpeechPlayback()
  }
}

/** 切换静音；返回切换后是否静音 */
export function toggleMeetingTtsMuted() {
  setMeetingTtsMuted(!_muted, { unlock: true })
  return _muted
}

/** 用户手势（发送 / 开麦）后：解锁自动播放并打开播报 */
export function enableMeetingTtsFromUserGesture() {
  void unlockSpeechPlayback()
  if (_muted) setMeetingTtsMuted(false, { unlock: true })
}

export function stopMeetingTts() {
  queue.stop()
}

export function resetMeetingTtsSession() {
  queue.reset()
}

/**
 * @param {{
 *   meetingRoomOpen?: boolean
 *   meetingActiveSpeaker?: string
 *   meetingMessages?: Array<Record<string, unknown>>
 *   agents?: unknown[]
 * }} st
 */
export function syncMeetingTts(st) {
  return queue.sync({
    open: !!st?.meetingRoomOpen,
    muted: _muted,
    messages: mapMeetingMessages(st?.meetingMessages || []),
    agents: st?.agents || [],
  })
}
