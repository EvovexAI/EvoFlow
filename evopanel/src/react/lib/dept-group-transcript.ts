/**
 * 部门群时间线落库：session_key = dept:{deptId}:chat
 * 与员工 sticky ``proactive:{code}:chat:dept-{deptId}`` 通过 content_json.dept_group 关联。
 */
import { api, gatewayProxy } from '../../lib/tauri-api.js'
import { deptChatSessionKey } from './dept-chat-session.js'
import { deptMemberWorkSessionKey } from './dept-member-work-session.js'

export const DEPT_CHAT_LS_PREFIX = 'evo-home-dept-chat:'
export const STREAMING_STALE_MS = 15 * 60 * 1000

export type DeptGroupMsgKind = 'user' | 'agent' | 'system'
export type DeptGroupStreamState = 'streaming' | 'final' | 'error'

export type DeptGroupTimelineMsg = {
  id: string
  kind: DeptGroupMsgKind
  agentCode?: string
  agentName?: string
  text: string
  ts: number
  mentions?: string[]
  streaming?: boolean
  fromAgentName?: string
  error?: boolean
  workSessionKey?: string
  wakeJobId?: string
}

export type DeptGroupMeta = {
  dept_id: string
  dept_name?: string
  msg_kind: DeptGroupMsgKind
  speaker_code?: string
  speaker_name?: string
  work_session_key?: string
  wake_job_id?: string
  stream_state?: DeptGroupStreamState
  from_agent_name?: string
  mentions?: string[]
}

function lsKey(deptId: string): string {
  return `${DEPT_CHAT_LS_PREFIX}${String(deptId || '').trim()}`
}

export function buildDeptGroupContentJson(
  msg: DeptGroupTimelineMsg,
  opts: { deptId: string; deptName?: string; streamState?: DeptGroupStreamState },
): Record<string, unknown> {
  const streamState: DeptGroupStreamState =
    opts.streamState ||
    (msg.error ? 'error' : msg.streaming ? 'streaming' : 'final')
  const meta: DeptGroupMeta = {
    dept_id: String(opts.deptId || '').trim(),
    dept_name: String(opts.deptName || '').trim() || undefined,
    msg_kind: msg.kind,
    speaker_code: msg.kind === 'user' ? 'user' : msg.agentCode,
    speaker_name: msg.kind === 'user' ? '你' : msg.agentName,
    work_session_key: msg.workSessionKey,
    wake_job_id: msg.wakeJobId,
    stream_state: streamState,
    from_agent_name: msg.fromAgentName,
    mentions: msg.mentions,
  }
  return {
    content: String(msg.text || ''),
    dept_group: meta,
  }
}

export function mapApiRowToDeptGroupMsg(row: any): DeptGroupTimelineMsg | null {
  if (!row || typeof row !== 'object') return null
  const payload =
    row.content_json && typeof row.content_json === 'object'
      ? row.content_json
      : row.contentJson && typeof row.contentJson === 'object'
        ? row.contentJson
        : typeof row.content === 'object' && row.content
          ? row.content
          : {}
  const dg =
    (payload.dept_group && typeof payload.dept_group === 'object' && payload.dept_group) ||
    (payload.deptGroup && typeof payload.deptGroup === 'object' && payload.deptGroup) ||
    {}
  const text =
    typeof payload.content === 'string'
      ? payload.content
      : typeof row.content === 'string'
        ? row.content
        : ''
  const mid = String(row.message_id || row.messageId || row.id || '').trim()
  if (!mid && !text) return null
  const toolName = String(row.tool_name || row.toolName || row.name || '').trim()
  // wake 审计行由 dept-group-audit 单独解析，不进群气泡时间线
  if (
    toolName === 'dept_group_wake' ||
    mid.startsWith('wake-evt-') ||
    String(dg.event_type || dg.eventType || '') === 'wake_status'
  ) {
    return null
  }
  const kindRaw = String(dg.msg_kind || dg.msgKind || '').trim()
  let kind: DeptGroupMsgKind = 'user'
  if (kindRaw === 'agent' || kindRaw === 'system' || kindRaw === 'user') {
    kind = kindRaw
  } else {
    const role = String(row.role || '').toLowerCase()
    kind = role === 'assistant' || role === 'ai' ? 'agent' : 'user'
    if (toolName === 'dept_group_system') kind = 'system'
  }
  const streamState = String(dg.stream_state || dg.streamState || row.turn_state || row.turnState || '')
    .trim()
    .toLowerCase()
  const streaming = streamState === 'streaming'
  const error = streamState === 'error' || !!row.error
  const ts =
    Number(row.created_at_ms || row.createdAtMs) ||
    (row.timestamp ? Date.parse(String(row.timestamp)) : 0) ||
    (row.created_at ? Date.parse(String(row.created_at)) : 0) ||
    Date.now()
  return {
    id: mid || `row-${ts}`,
    kind,
    agentCode:
      kind === 'agent' || kind === 'system'
        ? String(dg.speaker_code || dg.speakerCode || '').trim() || undefined
        : undefined,
    agentName:
      kind === 'agent' || kind === 'system'
        ? String(dg.speaker_name || dg.speakerName || '').trim() || undefined
        : undefined,
    text: String(text || ''),
    ts,
    mentions: Array.isArray(dg.mentions) ? dg.mentions.map(String) : undefined,
    streaming,
    fromAgentName: String(dg.from_agent_name || dg.fromAgentName || '').trim() || undefined,
    error,
    workSessionKey: String(dg.work_session_key || dg.workSessionKey || '').trim() || undefined,
    wakeJobId: String(dg.wake_job_id || dg.wakeJobId || '').trim() || undefined,
  }
}

/** 打开群时：超时仍 streaming 的标成未完成 */
export function staleStreamingToError(
  msgs: DeptGroupTimelineMsg[],
  opts?: { now?: number; staleMs?: number },
): DeptGroupTimelineMsg[] {
  const now = opts?.now ?? Date.now()
  const staleMs = opts?.staleMs ?? STREAMING_STALE_MS
  return msgs.map((m) => {
    if (!m.streaming) return m
    if (now - Number(m.ts || 0) < staleMs) return m
    return {
      ...m,
      streaming: false,
      error: true,
      text: m.text?.trim() ? m.text : '（回复未完成）',
    }
  })
}

export async function ensureDeptGroupSession(opts: {
  deptId: string
  deptName?: string
}): Promise<string> {
  const deptId = String(opts.deptId || '').trim()
  const sk = deptChatSessionKey(deptId)
  if (!sk) throw new Error('缺少部门')
  const title = String(opts.deptName || '').trim() || '部门群聊'
  try {
    await api.chatSessionsCreate('main', {
      sessionKey: sk,
      title,
      ensureThread: false,
      context: {
        dept_group_id: deptId,
        dept_group_name: title,
        dept_group_im: true,
        workspace_kind: 'dept_group',
        session_mode: 'agent',
      },
    })
  } catch {
    /* 已存在 */
  }
  try {
    await api.chatUpdateContext?.(sk, {
      dept_group_id: deptId,
      dept_group_name: title,
      dept_group_im: true,
      workspace_kind: 'dept_group',
    })
  } catch {
    /* optional */
  }
  return sk
}

const MIRROR_ID_PREFIX = 'dept-reply-'

function isMirrorMsg(m: DeptGroupTimelineMsg): boolean {
  return String(m?.id || '').startsWith(MIRROR_ID_PREFIX)
}

/**
 * 读取侧兜底去重：**只**在「后端镜像条目」与「前端气泡」互为重复时合并。
 *
 * 为什么需要：后端镜像（dept-reply-*）与前端气泡（agent-*）是两条独立写入路径。
 * 镜像优先接管前端占位行，但占位行若比镜像晚落库，就会各留一条 → 群里同一句
 * 出现两遍。写入侧已尽力，读取侧再兜一层。
 *
 * 判据的边界（故意收窄，宁可少删不可多删）：
 * - 只有「一条带 dept-reply- 前缀、另一条不带」才算同一句的两份拷贝；
 * - 两条都是前端气泡（同一 Agent 两轮都回「收到」）→ **都留**，那是两次真实发言；
 * - 两条都是镜像、id 不同 → 也留，确定性键不同说明是不同轮次；
 * - 窗口 10 分钟；命中时保留非镜像那条（带 wakeJobId/workSessionKey，交互信息更全），
 *   并且**原位替换**，不打乱时间顺序。
 *
 * 另有一类专门处理：**幽灵占位行**——正文为空、`streaming` 一直没定稿的前端气泡
 * （前端跑到一半被关掉就会留下）。现网实测它比镜像晚 19 秒落库，若不过滤，
 * 群里会出现「（回复未完成）」+ 真实回复两条。
 *
 * 【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
 */
export function dedupeMirroredReplies(
  msgs: DeptGroupTimelineMsg[],
  opts?: { windowMs?: number },
): DeptGroupTimelineMsg[] {
  const windowMs = opts?.windowMs ?? 10 * 60 * 1000
  const norm = (t: string) => String(t || '').replace(/\s+/g, ' ').trim()
  const kept: DeptGroupTimelineMsg[] = []
  const seen = new Map<string, number[]>()
  for (const m of msgs) {
    const text = m.kind === 'agent' ? norm(m.text) : ''
    if (!text) {
      kept.push(m)
      continue
    }
    const key = `${m.agentCode || ''}::${text}`
    const idxs = seen.get(key) || []
    const mirror = isMirrorMsg(m)
    const dupIdx = idxs.find((idx) => {
      const other = kept[idx]
      if (Math.abs((other?.ts || 0) - (m.ts || 0)) > windowMs) return false
      // 只有「镜像 ↔ 前端」这一对才算重复；同类条目一律各留
      return isMirrorMsg(other) !== mirror
    })
    if (mirror && dupIdx !== undefined) {
      // 镜像让位
      continue
    }
    if (!mirror && dupIdx !== undefined) {
      // 前端那条后到：原位替换镜像条目（顺序不变，信息更全）
      kept[dupIdx] = m
      continue
    }
    idxs.push(kept.length)
    seen.set(key, idxs)
    kept.push(m)
  }

  // 幽灵占位行：正文空 + 仍停在 streaming + **确认已死** + 同发言人已有一条镜像回复。
  //
  // 时间基准不能直接用 `m.ts`：现网实测那条幽灵行的 `created_at` 是**裸 UTC 串**
  // （`2026-11-20 00:12:00`，实为本地 08:12），前端按本地解析得到 8 小时前，
  // 与镜像行差 -480 分钟 → 只按 ts 比窗口永远抓不到它。所以时间优先取
  // 前端气泡 id 末段的毫秒（`agent-{code}-{epochMs}`，不受时区写法影响；
  // 现网样本：id 末段 1795133520906 vs 镜像 1795133501753，差 19s）。
  //
  // 「确认已死」这一条不能省：用户再次 @ 同一人时，前端会先写一条同人的空占位
  // （正文空、streaming），若只按「同人时间相近」过滤，会把**正在流式中**的
  // 真气泡提前删掉。判据是它已经超过 STREAMING_STALE_MS（15 分钟）——活着的前端
  // 早就 finalize 了，超窗还空着就是跑到一半被杀掉的残留。
  const timeOf = (m: DeptGroupTimelineMsg): number => {
    const hit = /(\d{12,})$/.exec(String(m?.id || ''))
    const fromId = hit ? Number(hit[1]) : NaN
    return Number.isFinite(fromId) ? fromId : Number(m.ts || 0)
  }
  const now = Date.now()
  const mirrorReplies = kept.filter((m) => isMirrorMsg(m) && norm(m.text))
  return kept.filter((m) => {
    if (m.kind !== 'agent' || norm(m.text) || !m.streaming) return true
    // 还活着（未超 stale 窗口）→ 正在流式输出，必须留
    if (now - Number(m.ts || 0) < STREAMING_STALE_MS) return true
    const at = timeOf(m)
    return !mirrorReplies.some(
      (r) => r.agentCode === m.agentCode && Math.abs(timeOf(r) - at) <= windowMs,
    )
  })
}

export async function loadDeptGroupMessages(
  deptId: string,
  opts?: {
    limit?: number
    deptName?: string
    finalizeStale?: boolean
  },
): Promise<DeptGroupTimelineMsg[]> {
  const limit = opts?.limit ?? 200
  const deptName = opts?.deptName
  const finalizeStale = opts?.finalizeStale !== false
  const sk = deptChatSessionKey(deptId)
  if (!sk) return []
  try {
    // bypassCache：刚写入后 20s 内 remount 不能吃到空历史缓存
    const hist = await api.chatHistory(sk, limit, { bypassCache: true })
    const rows = Array.isArray(hist?.messages)
      ? hist.messages
      : Array.isArray(hist)
        ? hist
        : []
    const mapped = rows
      .map((r: any) => mapApiRowToDeptGroupMsg(r))
      .filter(Boolean) as DeptGroupTimelineMsg[]
    const cleaned = staleStreamingToError(dedupeMirroredReplies(mapped))
    if (finalizeStale) {
      for (const before of mapped) {
        if (!before.streaming) continue
        const after = cleaned.find((m) => m.id === before.id)
        if (after?.error) {
          void finalizeDeptGroupMessage(after, { deptId, deptName }).catch((err) => {
            console.warn('[dept-group] finalize stale failed', after.id, err)
          })
        }
      }
    }
    return cleaned
  } catch (err) {
    console.warn('[dept-group] load messages failed', deptId, err)
    return []
  }
}

/** Write-through local backup so restart can migrate if DB write failed. */
export function writeLocalDeptChatBackup(deptId: string, msgs: DeptGroupTimelineMsg[]): void {
  const id = String(deptId || '').trim()
  if (!id) return
  try {
    const stable = (Array.isArray(msgs) ? msgs : [])
      .filter((m) => m && m.id && !m.streaming)
      .slice(-400)
    localStorage.setItem(lsKey(id), JSON.stringify(stable))
  } catch {
    /* quota / private mode */
  }
}

export async function upsertDeptGroupMessage(
  msg: DeptGroupTimelineMsg,
  opts: { deptId: string; deptName?: string; streamState?: DeptGroupStreamState },
): Promise<void> {
  const sk = deptChatSessionKey(opts.deptId)
  if (!sk || !msg?.id) return
  const streamState: DeptGroupStreamState =
    opts.streamState ||
    (msg.error ? 'error' : msg.streaming ? 'streaming' : 'final')
  // 定稿才写 LS；流式占位不占备份
  if (streamState !== 'streaming') {
    try {
      const prev = readLocalDeptChatBackup(opts.deptId)
      const next = [...prev.filter((m) => m.id !== msg.id), { ...msg, streaming: false }]
      writeLocalDeptChatBackup(opts.deptId, next)
    } catch {
      /* ignore */
    }
  }
  await ensureDeptGroupSession({ deptId: opts.deptId, deptName: opts.deptName })
  const role = msg.kind === 'agent' ? 'assistant' : 'user'
  const contentJson = buildDeptGroupContentJson(msg, {
    deptId: opts.deptId,
    deptName: opts.deptName,
    streamState,
  })
  const body: Record<string, unknown> = {
    role,
    content: msg.text || '',
    contentJson,
    messageId: msg.id,
    upsertByMessageId: true,
    turnState: streamState,
  }
  if (msg.kind === 'system') {
    body.toolName = 'dept_group_system'
  }
  await gatewayProxy('POST', `/chat/sessions/${encodeURIComponent(sk)}/messages`, body)
}

export async function appendDeptGroupMessage(
  msg: DeptGroupTimelineMsg,
  opts: { deptId: string; deptName?: string },
): Promise<void> {
  return upsertDeptGroupMessage(msg, {
    ...opts,
    streamState: msg.error ? 'error' : msg.streaming ? 'streaming' : 'final',
  })
}

export async function finalizeDeptGroupMessage(
  msg: DeptGroupTimelineMsg,
  opts: { deptId: string; deptName?: string },
): Promise<void> {
  return upsertDeptGroupMessage(
    { ...msg, streaming: false },
    {
      ...opts,
      streamState: msg.error ? 'error' : 'final',
    },
  )
}

export function readLocalDeptChatBackup(deptId: string): DeptGroupTimelineMsg[] {
  try {
    const raw = localStorage.getItem(lsKey(deptId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return (parsed as DeptGroupTimelineMsg[]).filter((m) => m && !m.streaming)
  } catch {
    return []
  }
}

export function clearLocalDeptChatBackup(deptId: string): void {
  try {
    localStorage.removeItem(lsKey(deptId))
  } catch {
    /* ignore */
  }
}

/**
 * 库空时把 localStorage 一次性导入；成功后清 LS。
 */
export async function migrateLocalDeptChatIfNeeded(opts: {
  deptId: string
  deptName?: string
}): Promise<DeptGroupTimelineMsg[]> {
  const deptId = String(opts.deptId || '').trim()
  await ensureDeptGroupSession(opts)
  const fromDb = await loadDeptGroupMessages(deptId, {
    deptName: opts.deptName,
    finalizeStale: true,
  })
  if (fromDb.length) {
    // DB 已有权威副本，清掉可能过期的 LS
    clearLocalDeptChatBackup(deptId)
    return fromDb
  }
  const local = readLocalDeptChatBackup(deptId)
  if (!local.length) return []
  for (const m of local.slice(-400)) {
    try {
      await appendDeptGroupMessage(m, opts)
    } catch (err) {
      console.warn('[dept-group] migrate local msg failed', m?.id, err)
    }
  }
  const after = await loadDeptGroupMessages(deptId, {
    deptName: opts.deptName,
    finalizeStale: false,
  })
  if (after.length) clearLocalDeptChatBackup(deptId)
  return after
}

export function workSessionKeyForSpeaker(deptId: string, agentCode: string): string {
  return deptMemberWorkSessionKey(deptId, agentCode)
}
