/**
 * 部门群聊审计：wake 状态机落盘 + 运维页读时间线。
 * 气泡正文走 dept-group-transcript；此处追加 append-only 的 wake 事件行
 *（tool_name=dept_group_wake，不进用户可见时间线）。
 */
import { api, gatewayProxy } from '../../lib/tauri-api.js'
import {
  deptChatSessionKey,
  deptIdFromSessionKey,
  isDeptChatSessionKey,
} from './dept-chat-session.js'
import {
  ensureDeptGroupSession,
  loadDeptGroupMessages,
  mapApiRowToDeptGroupMsg,
  type DeptGroupTimelineMsg,
} from './dept-group-transcript.js'
import type { WakeJobSnapshot, WakeJobStatus } from './dept-group-wake-queue.js'

export const DEPT_GROUP_WAKE_TOOL = 'dept_group_wake'

export type DeptGroupWakeEvent = {
  id: string
  deptId: string
  deptName?: string
  jobId: string
  agentCode: string
  roleName: string
  status: WakeJobStatus
  attempts: number
  goal?: string
  error?: string
  sourceMsgId?: string
  chainKey?: string
  ts: number
}

export type DeptGroupSessionSummary = {
  deptId: string
  sessionKey: string
  title: string
  updatedAt?: number
  messageCount?: number
}

export type DeptMemberAuditStatus = {
  agentCode: string
  roleName: string
  /** 由最近 wake 事件推导 */
  phase: 'idle' | 'queued' | 'running' | 'done' | 'failed'
  lastStatus?: WakeJobStatus
  lastJobId?: string
  lastTs?: number
  lastError?: string
  attempts?: number
}

function wakeEventMessageId(ev: {
  jobId: string
  status: string
  attempts: number
  ts: number
}): string {
  return `wake-evt-${ev.jobId}-${ev.status}-a${ev.attempts}-${ev.ts}`
}

export function isDeptGroupWakeAuditMsg(msg: DeptGroupTimelineMsg | null | undefined): boolean {
  if (!msg) return false
  if (String(msg.id || '').startsWith('wake-evt-')) return true
  return false
}

/** 把 wake 状态变迁写成独立消息行（同状态同 attempt 幂等 upsert） */
export async function persistDeptGroupWakeEvent(
  ev: Omit<DeptGroupWakeEvent, 'id'> & { id?: string },
): Promise<string> {
  const deptId = String(ev.deptId || '').trim()
  const jobId = String(ev.jobId || '').trim()
  const agentCode = String(ev.agentCode || '').trim()
  if (!deptId || !jobId || !agentCode) return ''
  const ts = Number(ev.ts) || Date.now()
  const status = ev.status
  const attempts = Math.max(0, Number(ev.attempts) || 0)
  const id =
    String(ev.id || '').trim() ||
    wakeEventMessageId({ jobId, status, attempts, ts })
  const roleName = String(ev.roleName || '').trim() || agentCode
  const goal = String(ev.goal || '').trim()
  const err = String(ev.error || '').trim()
  const label = [
    roleName,
    status,
    attempts > 0 ? `第${attempts}次` : '',
    err ? `· ${err.slice(0, 80)}` : '',
  ]
    .filter(Boolean)
    .join(' ')

  await ensureDeptGroupSession({ deptId, deptName: ev.deptName })
  const sk = deptChatSessionKey(deptId)
  const contentJson = {
    content: label,
    dept_group: {
      dept_id: deptId,
      dept_name: String(ev.deptName || '').trim() || undefined,
      msg_kind: 'system',
      event_type: 'wake_status',
      speaker_code: agentCode,
      speaker_name: roleName,
      wake_job_id: jobId,
      stream_state: status === 'failed' ? 'error' : 'final',
      source_msg_id: ev.sourceMsgId,
      chain_key: ev.chainKey,
      wake_status: status,
      wake_attempts: attempts,
      wake_goal: goal.slice(0, 400) || undefined,
      wake_error: err || undefined,
    },
  }
  await gatewayProxy('POST', `/chat/sessions/${encodeURIComponent(sk)}/messages`, {
    role: 'user',
    content: label,
    contentJson,
    messageId: id,
    upsertByMessageId: true,
    turnState: 'final',
    toolName: DEPT_GROUP_WAKE_TOOL,
  })
  return id
}

/** 从队列 snapshot 差分出需要落盘的变迁（同 job 同 status+attempt 不重复） */
export function diffWakeJobTransitions(
  prevSigByJob: Map<string, string>,
  jobs: WakeJobSnapshot[],
): WakeJobSnapshot[] {
  const changed: WakeJobSnapshot[] = []
  for (const j of jobs || []) {
    const id = String(j.id || '').trim()
    if (!id) continue
    const sig = `${j.status}|${j.attempts}|${j.error || ''}`
    if (prevSigByJob.get(id) === sig) continue
    prevSigByJob.set(id, sig)
    changed.push(j)
  }
  return changed
}

export async function listDeptGroupSessions(limit = 100): Promise<DeptGroupSessionSummary[]> {
  const out: DeptGroupSessionSummary[] = []
  const seen = new Set<string>()
  try {
    const res = await api.chatSessionsList(Math.max(limit, 50), 0)
    const rows = Array.isArray(res?.sessions)
      ? res.sessions
      : Array.isArray(res?.items)
        ? res.items
        : Array.isArray(res)
          ? res
          : []
    for (const row of rows) {
      const sk = String(row?.sessionKey || row?.session_key || row?.key || '').trim()
      if (!isDeptChatSessionKey(sk) || seen.has(sk)) continue
      seen.add(sk)
      const deptId = deptIdFromSessionKey(sk)
      const title =
        String(row?.title || row?.name || '').trim() ||
        String(row?.context?.dept_group_name || '').trim() ||
        `部门群 ${deptId}`
      const updatedAt =
        Number(row?.updatedAtMs || row?.updated_at_ms) ||
        (row?.updatedAt ? Date.parse(String(row.updatedAt)) : 0) ||
        (row?.updated_at ? Date.parse(String(row.updated_at)) : 0) ||
        undefined
      out.push({
        deptId,
        sessionKey: sk,
        title,
        updatedAt: updatedAt || undefined,
        messageCount: Number(row?.messageCount || row?.message_count) || undefined,
      })
    }
  } catch (err) {
    console.warn('[dept-group-audit] list sessions failed', err)
  }
  // 标题搜索兜底：侧栏分页可能截断
  if (out.length < 3) {
    try {
      const hit = await api.chatSessionsSearch('dept:', limit)
      const rows = Array.isArray(hit?.sessions)
        ? hit.sessions
        : Array.isArray(hit?.items)
          ? hit.items
          : Array.isArray(hit)
            ? hit
            : []
      for (const row of rows) {
        const sk = String(row?.sessionKey || row?.session_key || '').trim()
        if (!isDeptChatSessionKey(sk) || seen.has(sk)) continue
        seen.add(sk)
        const deptId = deptIdFromSessionKey(sk)
        out.push({
          deptId,
          sessionKey: sk,
          title: String(row?.title || '').trim() || `部门群 ${deptId}`,
        })
      }
    } catch {
      /* optional */
    }
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  return out.slice(0, limit)
}

export type DeptGroupAuditTrail = {
  deptId: string
  sessionKey: string
  messages: DeptGroupTimelineMsg[]
  wakeEvents: DeptGroupWakeEvent[]
  memberStatus: DeptMemberAuditStatus[]
}

function parseWakeEventFromRow(row: any): DeptGroupWakeEvent | null {
  const payload =
    row?.content_json && typeof row.content_json === 'object'
      ? row.content_json
      : row?.contentJson && typeof row.contentJson === 'object'
        ? row.contentJson
        : {}
  const dg =
    (payload.dept_group && typeof payload.dept_group === 'object' && payload.dept_group) || {}
  const tool = String(row?.tool_name || row?.toolName || '').trim()
  const mid = String(row?.message_id || row?.messageId || row?.id || '').trim()
  const isWake =
    tool === DEPT_GROUP_WAKE_TOOL ||
    mid.startsWith('wake-evt-') ||
    String(dg.event_type || '') === 'wake_status'
  if (!isWake) return null
  const ts =
    Number(row?.created_at_ms || row?.createdAtMs) ||
    (row?.timestamp ? Date.parse(String(row.timestamp)) : 0) ||
    Date.now()
  const status = String(dg.wake_status || dg.wakeStatus || 'queued').trim() as WakeJobStatus
  return {
    id: mid || `wake-${ts}`,
    deptId: String(dg.dept_id || dg.deptId || '').trim(),
    deptName: String(dg.dept_name || dg.deptName || '').trim() || undefined,
    jobId: String(dg.wake_job_id || dg.wakeJobId || '').trim(),
    agentCode: String(dg.speaker_code || dg.speakerCode || '').trim(),
    roleName: String(dg.speaker_name || dg.speakerName || '').trim(),
    status: ['queued', 'running', 'done', 'failed'].includes(status) ? status : 'queued',
    attempts: Number(dg.wake_attempts ?? dg.wakeAttempts) || 0,
    goal: String(dg.wake_goal || dg.wakeGoal || '').trim() || undefined,
    error: String(dg.wake_error || dg.wakeError || '').trim() || undefined,
    sourceMsgId: String(dg.source_msg_id || dg.sourceMsgId || '').trim() || undefined,
    chainKey: String(dg.chain_key || dg.chainKey || '').trim() || undefined,
    ts,
  }
}

/** 审计事件 → 派工条可用的最新 job 快照（同 jobId 取终态优先的最新一条） */
export function wakeEventsToJobSnapshots(events: DeptGroupWakeEvent[]): WakeJobSnapshot[] {
  const byJob = new Map<string, WakeJobSnapshot>()
  const sorted = [...events].sort((a, b) => a.ts - b.ts)
  for (const ev of sorted) {
    const jobId = String(ev.jobId || '').trim()
    const code = String(ev.agentCode || '').trim()
    if (!jobId || !code) continue
    byJob.set(jobId, {
      id: jobId,
      agentCode: code,
      roleName: String(ev.roleName || '').trim() || code,
      goal: String(ev.goal || '').trim(),
      status: ev.status,
      attempts: Math.max(0, Number(ev.attempts) || 0),
      error: ev.error,
      sourceMsgId: ev.sourceMsgId,
      updatedAt: Number(ev.ts) || Date.now(),
    })
  }
  return [...byJob.values()].sort((a, b) => a.updatedAt - b.updatedAt)
}

export function deriveMemberStatusFromWakeEvents(
  events: DeptGroupWakeEvent[],
): DeptMemberAuditStatus[] {
  const latest = new Map<string, DeptGroupWakeEvent>()
  const sorted = [...events].sort((a, b) => a.ts - b.ts)
  for (const ev of sorted) {
    const code = String(ev.agentCode || '').trim()
    if (!code) continue
    latest.set(code, ev)
  }
  return [...latest.values()]
    .map((ev) => {
      let phase: DeptMemberAuditStatus['phase'] = 'idle'
      if (ev.status === 'queued') phase = 'queued'
      else if (ev.status === 'running') phase = 'running'
      else if (ev.status === 'done') phase = 'done'
      else if (ev.status === 'failed') phase = 'failed'
      return {
        agentCode: ev.agentCode,
        roleName: ev.roleName || ev.agentCode,
        phase,
        lastStatus: ev.status,
        lastJobId: ev.jobId,
        lastTs: ev.ts,
        lastError: ev.error,
        attempts: ev.attempts,
      }
    })
    .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
}

/** 运维页：一次拉齐可见气泡 + wake 事件 + 成员态 */
export async function loadDeptGroupAuditTrail(
  deptId: string,
  opts?: { limit?: number; deptName?: string },
): Promise<DeptGroupAuditTrail> {
  const id = String(deptId || '').trim()
  const sk = deptChatSessionKey(id)
  // Gateway ``/messages`` Query le=200 — 400 会 422，正式包里表现为部门会话「一直转圈/空白」.
  const limit = Math.min(200, Math.max(1, Number(opts?.limit) || 200))
  const messages = (await loadDeptGroupMessages(id, {
    limit,
    deptName: opts?.deptName,
    finalizeStale: false,
  })).filter((m) => !isDeptGroupWakeAuditMsg(m))

  const wakeEvents: DeptGroupWakeEvent[] = []
  try {
    const hist = await api.chatHistory(sk, limit, { bypassCache: true })
    const rows = Array.isArray(hist?.messages)
      ? hist.messages
      : Array.isArray(hist)
        ? hist
        : []
    for (const row of rows) {
      const ev = parseWakeEventFromRow(row)
      if (ev) {
        if (!ev.deptId) ev.deptId = id
        wakeEvents.push(ev)
        continue
      }
      // 兼容：若 map 成 timeline 且 id 是 wake-evt
      const mapped = mapApiRowToDeptGroupMsg(row)
      if (mapped && isDeptGroupWakeAuditMsg(mapped)) {
        wakeEvents.push({
          id: mapped.id,
          deptId: id,
          jobId: mapped.wakeJobId || mapped.id,
          agentCode: mapped.agentCode || '',
          roleName: mapped.agentName || mapped.agentCode || '',
          status: mapped.error ? 'failed' : 'done',
          attempts: 0,
          ts: mapped.ts,
          goal: mapped.text,
        })
      }
    }
  } catch (err) {
    console.warn('[dept-group-audit] load wake events failed', id, err)
  }

  wakeEvents.sort((a, b) => a.ts - b.ts)
  return {
    deptId: id,
    sessionKey: sk,
    messages,
    wakeEvents,
    memberStatus: deriveMemberStatusFromWakeEvents(wakeEvents),
  }
}
