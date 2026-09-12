/**
 * 员工执行过程 / 工作过程：按正确 session_key 拉 transcript。
 * 对话落在 proactive:{code}:task:… / duty:…，不能只打旧的 proactive:{code}。
 */
import { api } from './tauri-api.js'

/** 与后端 ``_sanitize_session_suffix`` 对齐 */
export function sanitizeProactiveSessionSuffix(raw) {
  let s = String(raw || '').trim()
  if (!s) return ''
  s = s.replace(/[:/\\]/g, '-').replace(/\s+/g, '_')
  return s.slice(0, 180)
}

export function buildProactiveTaskSessionKey(agentCode, taskId) {
  const code = String(agentCode || '').trim()
  const tid = sanitizeProactiveSessionSuffix(taskId)
  if (!code || !tid) return ''
  return `proactive:${code}:task:${tid}`
}

export function buildProactiveDutySessionKey(agentCode, roundId) {
  const code = String(agentCode || '').trim()
  const suf = sanitizeProactiveSessionSuffix(roundId)
  if (!code || !suf) return ''
  return `proactive:${code}:duty:${suf}`
}

export function buildProactiveLegacySessionKey(agentCode) {
  const code = String(agentCode || '').trim()
  return code ? `proactive:${code}` : ''
}

/**
 * @param {any[]} conversations
 * @param {{ taskId?: string, roundId?: string }} opts
 */
export function pickProactiveConversationSessionKey(conversations, opts = {}) {
  const list = Array.isArray(conversations) ? conversations : []
  const taskId = String(opts.taskId || '').trim()
  const roundId = String(opts.roundId || '').trim()
  const roundSuf = sanitizeProactiveSessionSuffix(roundId)

  if (taskId) {
    const tid = sanitizeProactiveSessionSuffix(taskId)
    const hit = list.find((c) => {
      const sk = String(c?.session_key || '')
      const kind = String(c?.kind || '').toLowerCase()
      const ctid = sanitizeProactiveSessionSuffix(c?.task_id || '')
      return kind === 'task' && (ctid === tid || sk.endsWith(`:task:${tid}`))
    })
    if (hit?.session_key) return String(hit.session_key)
  }

  if (roundSuf) {
    const hit = list.find((c) => {
      const sk = String(c?.session_key || '')
      const kind = String(c?.kind || '').toLowerCase()
      return kind === 'duty' && (sk.endsWith(`:duty:${roundSuf}`) || sk.includes(`:duty:${roundSuf}`))
    })
    if (hit?.session_key) return String(hit.session_key)
  }

  const running = list.find((c) => String(c?.run_status || '').toLowerCase() === 'running')
  if (running?.session_key) return String(running.session_key)

  const preferred = list.find((c) => {
    const kind = String(c?.kind || '').toLowerCase()
    return kind === 'task' || kind === 'duty' || kind === 'chat'
  })
  if (preferred?.session_key) return String(preferred.session_key)

  return String(list[0]?.session_key || '').trim()
}

/**
 * 依次尝试候选会话，返回第一条非空 transcript。
 * @param {{
 *   agentCode: string
 *   taskId?: string
 *   roundId?: string
 *   sessionKey?: string
 * }} opts
 */
export async function fetchProactiveTranscript(opts = {}) {
  const code = String(opts.agentCode || '').trim()
  if (!code) {
    return { messages: [], session_key: '', round_id: '', cost: null, empty: true }
  }

  const taskId = String(opts.taskId || '').trim()
  const roundId = String(opts.roundId || '').trim()
  const explicitSk = String(opts.sessionKey || '').trim()

  /** @type {Array<{ session_key?: string, round_id?: string | null }>} */
  const candidates = []
  const seen = new Set()

  const push = (session_key, round_id = null) => {
    const sk = String(session_key || '').trim()
    const rid = round_id == null || round_id === '' ? null : String(round_id).trim()
    const key = `${sk}||${rid || ''}`
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ session_key: sk || undefined, round_id: rid })
  }

  if (explicitSk) push(explicitSk, null)

  if (taskId) push(buildProactiveTaskSessionKey(code, taskId), null)

  if (roundId) {
    push(buildProactiveDutySessionKey(code, roundId), null)
    // 旧库：消息可能仍在 legacy key 上按 round_id 过滤
    push(buildProactiveLegacySessionKey(code), roundId)
  }

  try {
    const convRes = await api.proactiveListConversations(code, { limit: 80 }).catch(() => null)
    const convs = Array.isArray(convRes?.conversations) ? convRes.conversations : []
    const picked = pickProactiveConversationSessionKey(convs, { taskId, roundId })
    if (picked) push(picked, null)
    // 最近若干会话兜底（running 优先已在 pick 里）
    for (const c of convs.slice(0, 8)) {
      const sk = String(c?.session_key || '').trim()
      if (sk) push(sk, null)
    }
  } catch {
    /* ignore */
  }

  // 最后：legacy 全量
  push(buildProactiveLegacySessionKey(code), null)
  // 无 session_key（后端默认 legacy）
  push('', roundId || null)
  push('', null)

  let last = { messages: [], session_key: '', round_id: '', cost: null, empty: true }

  for (const c of candidates) {
    const params = {}
    if (c.session_key) params.session_key = c.session_key
    if (c.round_id) params.round_id = c.round_id
    try {
      const res = await api.proactiveGetMessages(code, Object.keys(params).length ? params : null)
      const msgs = Array.isArray(res?.messages) ? res.messages : []
      last = { ...res, messages: msgs, empty: msgs.length === 0 }
      if (msgs.length > 0) return last
    } catch (e) {
      last = {
        messages: [],
        session_key: c.session_key || '',
        round_id: c.round_id || '',
        cost: null,
        empty: true,
        error: String(e?.message || e || '加载失败'),
      }
    }
  }

  return last
}
