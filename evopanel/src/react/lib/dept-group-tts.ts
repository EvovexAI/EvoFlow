/**
 * 部门群聊播报场景壳：mute + 定稿映射 + 历史基线（进群不从头念）+ 去重 + 台账。
 */

import { apiUrl } from '../../lib/api-client.js'
import { unlockSpeechPlayback } from '../../lib/speech-client.js'
import { createAgentTtsQueue, isAgentTtsSpeakableText } from '../../lib/agent-tts-queue.js'
import { logDeptGroupWake } from './dept-group-wake-log.js'

const STORAGE_KEY = 'evoflow.deptGroupTtsMuted'
const SPOKEN_LS_PREFIX = 'evoflow.deptGroupTtsSpoken:'
const TRAIL_LS_PREFIX = 'evoflow.deptGroupTtsTrail:'
const TRAIL_MAX = 80

/** 默认开麦 */
let muted = false
try {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw === '0') muted = false
  if (raw === '1') muted = true
} catch {
  /* ignore */
}

type TrailEntry = {
  key: string
  code: string
  text: string
  at: number
  status: 'played' | 'skipped' | 'stopped' | 'failed'
  reason?: string
}

const trail: TrailEntry[] = []
let boundDeptId = ''
/**
 * 历史基线未就绪前：只追平、绝不播。
 * 由 HomeDeptGroupChat 在时间线回填完成后 markDeptGroupTtsBaseline。
 */
let baselineReady = false

function spokenLsKey(deptId: string) {
  return `${SPOKEN_LS_PREFIX}${deptId}`
}

function trailLsKey(deptId: string) {
  return `${TRAIL_LS_PREFIX}${deptId}`
}

function loadSpoken(deptId: string): string[] {
  try {
    const raw = sessionStorage.getItem(spokenLsKey(deptId))
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.map((x) => String(x || '').trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

function saveSpoken(deptId: string, keys: string[]) {
  try {
    sessionStorage.setItem(spokenLsKey(deptId), JSON.stringify(keys.slice(-400)))
  } catch {
    /* ignore */
  }
}

function loadTrail(deptId: string): TrailEntry[] {
  try {
    const raw = sessionStorage.getItem(trailLsKey(deptId))
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? (arr as TrailEntry[]) : []
  } catch {
    return []
  }
}

function persistTrail(deptId: string) {
  try {
    sessionStorage.setItem(trailLsKey(deptId), JSON.stringify(trail.slice(-TRAIL_MAX)))
  } catch {
    /* ignore */
  }
}

/** 写入语音播报 SQLite 台账（与小V /playback 同源） */
function notePlaybackLedger(entry: TrailEntry, speaker = '') {
  void (async () => {
    try {
      const phase =
        entry.status === 'played'
          ? 'played'
          : entry.status === 'stopped'
            ? 'cancelled'
            : entry.status === 'failed'
              ? 'failed'
              : entry.status === 'skipped'
                ? 'cancelled'
                : 'queued'
      const body = {
        phase,
        source: 'dept_group',
        text: String(entry.text || '').slice(0, 1800),
        utterance_id: `dept:${boundDeptId || 'x'}:${entry.key}`.slice(0, 180),
        speaker: speaker || undefined,
        provider: 'volcengine',
        error: entry.status === 'failed' ? String(entry.reason || '').slice(0, 400) : undefined,
        trace_id: boundDeptId ? `dept-${boundDeptId}` : undefined,
      }
      const url = import.meta.env?.DEV
        ? '/api/speech/playback/note'
        : apiUrl('/speech/playback/note')
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
        keepalive: true,
      })
    } catch {
      /* ignore */
    }
  })()
}

function pushTrailEntry(entry: TrailEntry) {
  trail.push(entry)
  if (trail.length > TRAIL_MAX) trail.splice(0, trail.length - TRAIL_MAX)
  if (boundDeptId) persistTrail(boundDeptId)
  const preview = String(entry.text || '').slice(0, 80)
  logDeptGroupWake({
    event: `tts_${entry.status}`,
    zh: `播报·${entry.status}${entry.reason ? `·${entry.reason}` : ''} · ${entry.code} · ${preview}`,
    level: entry.status === 'failed' ? 'warn' : 'info',
    deptId: boundDeptId || undefined,
    agentCode: entry.code || undefined,
    detail: {
      key: entry.key,
      status: entry.status,
      reason: entry.reason || '',
    },
  })
  // skipped 的 enter/mute 追平太多，不灌台账；真正播/停/失败才记
  if (entry.status === 'played' || entry.status === 'stopped' || entry.status === 'failed') {
    notePlaybackLedger(entry)
  }
}

const queue = createAgentTtsQueue({
  logTag: 'dept-group-tts',
  onTrail: (e) => {
    pushTrailEntry(e as TrailEntry)
    if (boundDeptId) saveSpoken(boundDeptId, queue.getSpokenKeys())
  },
})

export type DeptGroupTtsMsg = {
  id?: string
  kind?: string
  agentCode?: string
  agent_code?: string
  text?: string
  streaming?: boolean
  error?: boolean
  ts?: number
}

export type DeptGroupTtsAgent = {
  agent_code?: string
  tts_speaker?: string | null
  tts_speech_rate?: number | null
  [key: string]: unknown
}

/** 播报前去掉 @提及（含「@名字」整段），避免念出「艾特某某」；气泡原文不动。 */
export function stripAtMentionsForTts(text: string): string {
  return String(text || '')
    .replace(/@\s*[^\s@，。！？；：、,.!?;:\n/）)】\]]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function mapDeptMessages(messages: DeptGroupTtsMsg[]) {
  const out: Array<{
    id: string
    agent_code: string
    text: string
    completed: boolean
    error: boolean
    ts: number
  }> = []
  for (const m of Array.isArray(messages) ? messages : []) {
    if (String(m?.kind || '') !== 'agent') continue
    const code = String(m.agentCode || m.agent_code || '').trim()
    const text = stripAtMentionsForTts(String(m.text || ''))
    const id = String(m.id || '')
    const streaming = !!m.streaming
    const error = !!m.error
    out.push({
      id,
      agent_code: code,
      text,
      completed: !streaming && !error && !!text,
      error,
      ts: Number(m.ts) || 0,
    })
  }
  return out
}

function bindDept(deptId: string) {
  if (!deptId) return
  if (boundDeptId === deptId) return
  queue.stop()
  boundDeptId = deptId
  baselineReady = false
  trail.length = 0
  trail.push(...loadTrail(deptId))
  // 换群：清空内存 spoken，再灌本群 session 去重；不要丢基线前刚 seed 的同群键
  queue.reset()
  queue.markSpokenKeys(loadSpoken(deptId))
}

export function getDeptGroupTtsUtterance() {
  return queue.getUtterance()
}

export function subscribeDeptGroupTtsUtterance(
  cb: (u: { key: string; code: string; text: string } | null) => void,
) {
  return queue.subscribeUtterance(cb)
}

export function getDeptGroupTtsTrail() {
  return trail.slice()
}

export function isDeptGroupTtsBaselineReady() {
  return baselineReady
}

export function isDeptGroupTtsMuted() {
  return muted
}

/** 把当前已定稿全部标成已播（不念出口） */
export function catchUpDeptGroupTts(messages: DeptGroupTtsMsg[], reason = 'catch_up') {
  const mapped = mapDeptMessages(messages)
  const n = queue.seedSpoken(
    mapped.filter((m) => m.completed),
    { reason },
  )
  if (boundDeptId) saveSpoken(boundDeptId, queue.getSpokenKeys())
  return n
}

/**
 * 历史回填完成：打基线。之后只播「新定稿」，绝不从头到尾念旧消息。
 */
export function markDeptGroupTtsBaseline(
  messages: DeptGroupTtsMsg[],
  deptId?: string,
) {
  const id = String(deptId || boundDeptId || '').trim()
  if (id) bindDept(id)
  catchUpDeptGroupTts(messages, 'history_baseline')
  baselineReady = true
  logDeptGroupWake({
    event: 'tts_baseline',
    zh: `播报基线已就绪（历史不播，只播之后新定稿）`,
    level: 'info',
    deptId: boundDeptId || undefined,
    detail: { spoken: queue.getSpokenKeys().length },
  })
}

export function setDeptGroupTtsMuted(
  next: boolean,
  opts: { unlock?: boolean; messages?: DeptGroupTtsMsg[] } = {},
) {
  muted = !!next
  try {
    localStorage.setItem(STORAGE_KEY, muted ? '1' : '0')
  } catch {
    /* ignore */
  }
  if (muted) {
    queue.stop()
    if (opts.messages) catchUpDeptGroupTts(opts.messages, 'mute_catch_up')
  } else if (opts.unlock !== false) {
    void unlockSpeechPlayback()
    if (opts.messages) catchUpDeptGroupTts(opts.messages, 'unmute_catch_up')
  }
}

export function toggleDeptGroupTtsMuted(messages?: DeptGroupTtsMsg[]) {
  setDeptGroupTtsMuted(!muted, { unlock: true, messages })
  return muted
}

export function enableDeptGroupTtsFromUserGesture(messages?: DeptGroupTtsMsg[]) {
  void unlockSpeechPlayback()
  if (muted) setDeptGroupTtsMuted(false, { unlock: true, messages })
}

export function stopDeptGroupTts() {
  queue.stop()
  if (boundDeptId) saveSpoken(boundDeptId, queue.getSpokenKeys())
}

export function pauseDeptGroupTts() {
  queue.stop()
  if (boundDeptId) saveSpoken(boundDeptId, queue.getSpokenKeys())
}

export function resetDeptGroupTtsSession() {
  pauseDeptGroupTts()
  boundDeptId = ''
  baselineReady = false
  trail.length = 0
}

export function syncDeptGroupTts(st: {
  deptId?: string
  open?: boolean
  messages?: DeptGroupTtsMsg[]
  agents?: DeptGroupTtsAgent[]
}) {
  const deptId = String(st?.deptId || '').trim()
  const open = st?.open !== false && !!deptId
  if (deptId) bindDept(deptId)
  if (!open) {
    pauseDeptGroupTts()
    return Promise.resolve()
  }
  const mapped = mapDeptMessages(st.messages || [])
  // 基线未就绪：只挡住播放，绝不 seedSpoken。
  // 若这里把加载窗口内刚定稿的新回复标成已播，基线就绪后也永远不会念。
  if (!baselineReady) {
    return Promise.resolve()
  }
  if (muted) return Promise.resolve()
  return queue.sync({
    open: true,
    muted,
    messages: mapped,
    agents: st.agents || [],
  })
}

export { isAgentTtsSpeakableText }
