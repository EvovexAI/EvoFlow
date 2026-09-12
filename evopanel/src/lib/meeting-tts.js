/**
 * AI员工聊天室播报：
 * - 只播「已完成」发言，严格一人说完再下一个
 * - 播报期间对外广播 utterance（气泡跟播报同步）
 * - 上一位播报时预取下一位 TTS，轮到再自然接上
 */

import {
  fetchSpeechConfigured,
  stopAllAssistantSpeech,
  unlockSpeechPlayback,
  playAssistantSpeech,
  prefetchAssistantSpeech,
  waitForSpeechPlaybackIdle,
  isSpeechPlaybackBusy,
} from './speech-client.js'
import { resolveMeetingAgentSpeaker } from './meeting-agent-voices.js'

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

/** @type {Set<string>} */
const _spokenCompleted = new Set()
/** @type {boolean | null} */
let _configured = null

/** 最新待同步状态（泵式消费，保证串行） */
let _latestSt = null
let _pumpRunning = false
/** 当前正在播报的消息 key，避免重入打断 */
let _playingKey = ''

/**
 * 当前 TTS 口播（气泡应对齐这个，而不是 LLM working）。
 * @type {{ key: string, code: string, text: string } | null}
 */
let _utterance = null
/** @type {Set<(u: typeof _utterance) => void>} */
const _utteranceListeners = new Set()

function msgKey(m) {
  return String(m?.id || `${m?.agent_code || ''}:${String(m?.text || '').slice(0, 24)}`)
}

/**
 * @param {unknown[]} agents
 * @param {string} code
 */
function findAgent(agents, code) {
  const key = String(code || '')
    .trim()
    .toLowerCase()
  if (!key) return null
  for (const a of agents || []) {
    const c = String(a?.agent_code || '')
      .trim()
      .toLowerCase()
    if (c === key) return a
  }
  return null
}

function setUtterance(next) {
  const a = _utterance
  const b = next
  const same =
    (!a && !b) ||
    (!!a &&
      !!b &&
      a.key === b.key &&
      a.code === b.code &&
      a.text === b.text)
  if (same) return
  _utterance = next
  for (const cb of _utteranceListeners) {
    try {
      cb(_utterance)
    } catch {
      /* ignore */
    }
  }
}

/** 当前正在 TTS 口播的发言（无则 null） */
export function getMeetingTtsUtterance() {
  return _utterance
}

/**
 * 订阅口播变化：开始播报时带上 code/text，结束时为 null。
 * @param {(u: { key: string, code: string, text: string } | null) => void} cb
 * @returns {() => void}
 */
export function subscribeMeetingTtsUtterance(cb) {
  if (typeof cb !== 'function') return () => {}
  _utteranceListeners.add(cb)
  try {
    cb(_utterance)
  } catch {
    /* ignore */
  }
  return () => _utteranceListeners.delete(cb)
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
    stopAllAssistantSpeech()
    _playingKey = ''
    setUtterance(null)
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
  stopAllAssistantSpeech()
  _playingKey = ''
  setUtterance(null)
}

export function resetMeetingTtsSession() {
  stopMeetingTts()
  _spokenCompleted.clear()
  _latestSt = null
}

async function ensureConfigured() {
  if (_configured !== null) return _configured
  try {
    _configured = await fetchSpeechConfigured()
  } catch {
    _configured = false
  }
  if (!_configured) {
    console.warn('[meeting-tts] 火山 TTS 未配置，会议室播报不可用')
  }
  return _configured
}

/**
 * 取出下一条尚未播报的完成发言（按消息列表顺序 = 发言先后）
 * @param {Array<Record<string, unknown>>} msgs
 */
function nextPendingCompleted(msgs) {
  for (const m of msgs) {
    if (m?.role !== 'agent') continue
    if (m.state !== 'completed' || m.error) continue
    const text = String(m.text || '').trim()
    if (!text || text === '(无回复)') continue
    const key = msgKey(m)
    if (_spokenCompleted.has(key)) continue
    if (_playingKey && key === _playingKey) continue
    return m
  }
  return null
}

/**
 * 预取后续已完成发言的 TTS（最多 2 条），不抢当前播报。
 * @param {{ agents?: unknown[], meetingMessages?: Array<Record<string, unknown>> }} st
 * @param {string} afterKey
 */
function prefetchFollowing(st, afterKey) {
  const msgs = Array.isArray(st.meetingMessages) ? st.meetingMessages : []
  let passed = !afterKey
  let n = 0
  for (const m of msgs) {
    if (m?.role !== 'agent') continue
    if (m.state !== 'completed' || m.error) continue
    const text = String(m.text || '').trim()
    if (!text || text === '(无回复)') continue
    const key = msgKey(m)
    if (!passed) {
      if (key === afterKey) passed = true
      continue
    }
    if (_spokenCompleted.has(key) || key === _playingKey) continue
    const code = String(m.agent_code || '').trim()
    if (!code) continue
    const agent = findAgent(st.agents, code)
    const speaker = resolveMeetingAgentSpeaker(code, agent)
    void prefetchAssistantSpeech(text, { speaker })
    n += 1
    if (n >= 2) break
  }
}

/**
 * @param {{
 *   meetingRoomOpen?: boolean
 *   meetingMessages?: Array<Record<string, unknown>>
 *   agents?: unknown[]
 * }} st
 */
async function playPendingQueue(st) {
  if (!st?.meetingRoomOpen || _muted) return
  if (!(await ensureConfigured())) return

  const msgs = Array.isArray(st.meetingMessages) ? st.meetingMessages : []

  // 严格串行：上一条完全播完，再取下一条；播报期间气泡显示，播完立刻收起
  while (!_muted && st.meetingRoomOpen) {
    if (isSpeechPlaybackBusy()) {
      await waitForSpeechPlaybackIdle({ timeoutMs: 180000 })
      if (_muted || !st.meetingRoomOpen) return
    }

    const next = nextPendingCompleted(
      Array.isArray(_latestSt?.meetingMessages) ? _latestSt.meetingMessages : st.meetingMessages || msgs,
    )
    if (!next) return

    const code = String(next.agent_code || '').trim()
    const text = String(next.text || '').trim()
    const key = msgKey(next)
    if (!code || !text) {
      _spokenCompleted.add(key)
      continue
    }

    // 先占位，避免泵重入时重复取同一条
    _spokenCompleted.add(key)
    _playingKey = key
    if (_spokenCompleted.size > 120) {
      const first = _spokenCompleted.values().next().value
      if (first) _spokenCompleted.delete(first)
    }

    const agent = findAgent(st.agents, code)
    const speaker = resolveMeetingAgentSpeaker(code, agent)

    // 气泡：内容已有就立刻挂上，跟播报同步；播完再清
    setUtterance({ key, code, text })
    // 上一位开口时，顺手预取后面已就绪的回复
    prefetchFollowing(_latestSt || st, key)

    try {
      console.log('[meeting-tts] play', code, speaker, text.slice(0, 40))
      await playAssistantSpeech(text, { speaker })
      await waitForSpeechPlaybackIdle({ timeoutMs: 30000 })
      await new Promise((r) => setTimeout(r, 220))
    } catch (e) {
      console.warn('[meeting-tts] play failed', e)
    } finally {
      if (_playingKey === key) _playingKey = ''
      // 说完立刻收气泡（不要等下一位）
      if (_utterance?.key === key) setUtterance(null)
    }

    // 播放期间可能有新完成发言，用最新快照继续
    if (_latestSt) {
      st = _latestSt
      _latestSt = null
      // 空档期也继续预取已就绪的下一位
      prefetchFollowing(st, '')
    }
  }
}

async function pump() {
  if (_pumpRunning) return
  _pumpRunning = true
  try {
    while (_latestSt) {
      const st = _latestSt
      _latestSt = null
      if (!st?.meetingRoomOpen) {
        stopMeetingTts()
        continue
      }
      if (_muted) {
        setUtterance(null)
        continue
      }
      // 即使还没轮到播，有完成发言也先预取
      prefetchFollowing(st, _playingKey || '')
      await playPendingQueue(st)
    }
  } catch (e) {
    console.warn('[meeting-tts] pump error', e)
  } finally {
    _pumpRunning = false
    // 泵结束时又有新状态
    if (_latestSt && !_muted) void pump()
  }
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
  _latestSt = st
  if (!st?.meetingRoomOpen) {
    stopMeetingTts()
    return Promise.resolve()
  }
  if (_muted) {
    setUtterance(null)
    return Promise.resolve()
  }
  // 有已完成未播的，尽早预取
  prefetchFollowing(st, _playingKey || '')
  return pump()
}
