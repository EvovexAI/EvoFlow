/**
 * 派工条状态：把 in-memory 叫醒队列 / 审计回灌 / 气泡已回 合成可读标签。
 */
import type { WakeJobSnapshot, WakeJobStatus } from './dept-group-wake-queue.js'

export function wakeStatusLabel(status: WakeJobStatus | undefined): string {
  if (status === 'queued') return '排队中'
  if (status === 'running') return '回答中'
  if (status === 'done') return '已回'
  if (status === 'failed') return '失败'
  return ''
}

/** live 覆盖同 id 的 audit；重挂后靠 audit 回填「已回」 */
export function mergeWakeJobSnapshots(
  live: WakeJobSnapshot[],
  audit: WakeJobSnapshot[],
): WakeJobSnapshot[] {
  const map = new Map<string, WakeJobSnapshot>()
  for (const j of audit || []) {
    const id = String(j?.id || '').trim()
    if (!id) continue
    map.set(id, j)
  }
  for (const j of live || []) {
    const id = String(j?.id || '').trim()
    if (!id) continue
    map.set(id, j)
  }
  return [...map.values()].sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
}

/**
 * 优先精确 sourceMsgId；其次进行中的 job（嵌套旧数据曾把 root 记成 source）；
 * 不再把别轮已完成 job 硬套到新 @ 上（那种靠 hasLaterReply →「已回」）。
 */
export function findWakeJobForMention(
  wakeJobs: WakeJobSnapshot[],
  opts: { agentCode: string; sourceMsgId?: string },
): WakeJobSnapshot | null {
  const code = String(opts.agentCode || '').trim()
  if (!code || !wakeJobs?.length) return null
  const sid = String(opts.sourceMsgId || '').trim()
  const forAgent = [...wakeJobs.filter((j) => j.agentCode === code)].reverse()
  if (!forAgent.length) return null
  if (!sid) return forAgent[0] || null
  const exact = forAgent.find((j) => j.sourceMsgId === sid)
  if (exact) return exact
  const active = forAgent.find((j) => j.status === 'queued' || j.status === 'running')
  if (active) return active
  const loose = forAgent.find((j) => !j.sourceMsgId)
  if (loose) return loose
  return null
}

export type ReplyEvidence = {
  agentCode?: string
  /** 回复气泡绑定的叫醒 job */
  wakeJobId?: string
  /** 本条之后是否已有该人定稿气泡（重挂后无队列时用） */
  repliedAfter?: boolean
}

/**
 * 合成派工态：有 job 用 job；否则若已有回复证据 → 已回；否则未入队。
 */
export function resolveMentionDispatchStatus(opts: {
  wakeJobs: WakeJobSnapshot[]
  agentCode: string
  sourceMsgId?: string
  /** 时间线上该 @ 之后已出现此人非空回复 */
  hasLaterReply?: boolean
}): { status?: WakeJobStatus; label: string; miss: boolean } {
  const job = findWakeJobForMention(opts.wakeJobs, {
    agentCode: opts.agentCode,
    sourceMsgId: opts.sourceMsgId,
  })
  if (job?.status) {
    const label = wakeStatusLabel(job.status)
    return { status: job.status, label, miss: false }
  }
  if (opts.hasLaterReply) {
    return { status: 'done', label: '已回', miss: false }
  }
  return { label: '未入队', miss: true }
}
