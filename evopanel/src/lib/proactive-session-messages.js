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
 *   agentCode: string,
 *   taskId?: string,
 *   roundId?: string,
 *   sessionKey?: string,
 * }} opts
 * @returns {Promise<{
 *   messages: any[],
 *   session_key?: string,
 *   round_id?: string,
 *   cost?: { total_tokens?: number | null } | null,
 *   empty?: boolean,
 *   error?: string,
 * }>}
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

/**
 * 解析员工执行过程对应的 LangGraph thread（供右栏 V4 时间线订阅）。
 * 优先 conversations 列表里的 thread_id；必要时再 ensure-thread。
 *
 * @param {{
 *   agentCode: string,
 *   taskId?: string,
 *   roundId?: string,
 *   sessionKey?: string,
 *   ensureThread?: (sessionKey: string) => Promise<string>,
 *   // 【self-evolution-bot · 2026-11-20 · 第98轮 · 模型:deepseek-v4.1-flash-1017】
 *   // 改了什么：补上 autoBindSince 的声明（运行时第 271 行早就在读它）。
 *   // 为什么：调用点 v4-employee-process-pane.tsx:351 传了该字段，JSDoc 里没有，
 *   // tsc 报 TS2353 → 整个前端构建被卡住，构建不了就谈不上「构建重启」。
 *   autoBindSince?: number,
 * }} opts
 * @returns {Promise<{
 *   session_key: string,
 *   thread_id: string,
 *   run_status: string,
 *   role_name?: string,
 * }>}
 */
export async function resolveProactiveProcessMeta(opts = {}) {
  const code = String(opts.agentCode || '').trim()
  if (!code) {
    return { session_key: '', thread_id: '', run_status: '' }
  }
  // live:{code} 是右栏跟岗占位，不是真实 task session
  const rawTaskId = String(opts.taskId || '').trim()
  const taskId = rawTaskId.startsWith('live:') ? '' : rawTaskId
  const roundId = String(opts.roundId || '').trim()
  const explicitSk = String(opts.sessionKey || '').trim()

  /** @type {any[]} */
  let convs = []
  let roleName = ''
  try {
    const convRes = await api.proactiveListConversations(code, { limit: 80 }).catch(() => null)
    convs = Array.isArray(convRes?.conversations) ? convRes.conversations : []
    roleName = String(convRes?.role_name || '').trim()
  } catch {
    convs = []
  }

  let sk =
    explicitSk ||
    pickProactiveConversationSessionKey(convs, { taskId, roundId }) ||
    (taskId ? buildProactiveTaskSessionKey(code, taskId) : '') ||
    (roundId ? buildProactiveDutySessionKey(code, roundId) : '') ||
    buildProactiveLegacySessionKey(code)

  // 员工过程绝不能落到主聊 / 其它 agent 会话
  const looksLikeForeignSession = (key) => {
    const s = String(key || '').trim()
    if (!s) return true
    if (s.startsWith('agent:main:') || s === 'agent:main' || s.startsWith('agent:xiaomi:')) return true
    if (s.startsWith('proactive:')) {
      // 精确 legacy proactive:{code} 或 proactive:{code}:…
      const mine = s === `proactive:${code}` || s.startsWith(`proactive:${code}:`)
      return !mine
    }
    return false
  }

  // 平台/chat_send 指定了 session_key：只认这一条，绝不改绑到别的会话的 done 状态
  if (explicitSk) {
    if (looksLikeForeignSession(explicitSk)) {
      return {
        session_key: '',
        thread_id: '',
        run_status: '',
        role_name: roleName || undefined,
      }
    }
    sk = explicitSk
    const pinned = convs.find((c) => String(c?.session_key || '').trim() === explicitSk) || null
    let threadId = String(pinned?.thread_id || pinned?.threadId || '').trim()
    // 会话行尚未入库时不要冒充 done，留给面板继续轮询 / busy 兜底
    const runStatus = pinned
      ? String(pinned?.run_status || pinned?.runStatus || '').trim()
      : ''
    if (!threadId && typeof opts.ensureThread === 'function') {
      try {
        threadId = String((await opts.ensureThread(explicitSk)) || '').trim()
      } catch {
        /* optional */
      }
    }
    return {
      session_key: sk,
      thread_id: threadId,
      run_status: runStatus,
      role_name: roleName || undefined,
    }
  }

  // 【self-evolution-bot · 2026-11-20 · 第95轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：加了「自动绑定不得早于本次派发时刻」这道闸。
  // 为什么：同一员工同一时刻只跑一个任务，A 对话派单时它可能正跑着 B 对话派的任务。
  // 上一处修复把「换轮不继承旧会话键」改成清空后重新自动挑，而自动挑优先选
  // run_status=running 的那条 —— 恰好会挑到别人对话派的任务，用户看到的就是
  // 「我在这个对话派的话，右栏显示的是别的对话的内容」。宁可短暂空着继续轮询
  // （面板有 45s 宽限期），也不许把别人的会话显示到这一屏。
  const autoBindSince = Number(opts.autoBindSince) > 0 ? Number(opts.autoBindSince) : 0
  if (autoBindSince && !explicitSk && !taskId) {
    // 时钟/入库抖动容忍：会话行 created_at 可能比派发返回早几百毫秒
    const sinceMs = autoBindSince - 3000
    const createdAtMs = (c) => {
      const raw = String(c?.created_at || c?.createdAt || '').trim()
      const t = raw ? Date.parse(raw) : NaN
      return Number.isFinite(t) ? t : 0
    }
    const eligible = convs.filter((c) => !looksLikeForeignSession(c?.session_key) && createdAtMs(c) >= sinceMs)
    if (!eligible.length) {
      return { session_key: '', thread_id: '', run_status: '', role_name: roleName || undefined }
    }
    convs = eligible
  }

  if (looksLikeForeignSession(sk)) {
    sk =
      (taskId ? buildProactiveTaskSessionKey(code, taskId) : '') ||
      (roundId ? buildProactiveDutySessionKey(code, roundId) : '') ||
      buildProactiveLegacySessionKey(code)
  }

  // 闸生效时，不许再用「拼出来的猜测键」擅自绑会话（拼出来的键不是本次派发产生的那条）
  if (autoBindSince && !explicitSk && !taskId) {
    const picked = pickProactiveConversationSessionKey(convs, { taskId, roundId })
    sk = looksLikeForeignSession(picked) ? '' : picked
  }

  const hit =
    (sk &&
      !looksLikeForeignSession(sk) &&
      convs.find((c) => String(c?.session_key || '').trim() === sk)) ||
    (taskId &&
      convs.find((c) => {
        const ctid = sanitizeProactiveSessionSuffix(c?.task_id || '')
        const want = sanitizeProactiveSessionSuffix(taskId)
        return String(c?.kind || '').toLowerCase() === 'task' && ctid === want
      })) ||
    null

  if (hit?.session_key && !looksLikeForeignSession(hit.session_key)) {
    sk = String(hit.session_key).trim()
  }
  let threadId = String(hit?.thread_id || hit?.threadId || '').trim()
  const runStatus = String(hit?.run_status || hit?.runStatus || '').trim()

  if (!threadId && sk && !looksLikeForeignSession(sk) && typeof opts.ensureThread === 'function') {
    try {
      threadId = String((await opts.ensureThread(sk)) || '').trim()
    } catch {
      /* optional */
    }
  }

  return {
    session_key: looksLikeForeignSession(sk) ? '' : sk,
    thread_id: looksLikeForeignSession(sk) ? '' : threadId,
    run_status: looksLikeForeignSession(sk) ? '' : runStatus,
    role_name: roleName || undefined,
  }
}
