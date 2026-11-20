/**
 * 部门群聊叫醒队列的**旁路持久化**。
 *
 * 【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
 *
 * ## 设计边界（这条最重要）
 *
 * 本模块**不接管**编排。谁该被叫醒、防环、合并、串行、退避重试，
 * 仍然全部由 `DeptGroupWakeQueue`（前端内存队列）负责——它已经过多轮线上验证。
 * 这里只做一件事：把「入队/状态推进/恢复」这三个事实**顺手抄一份到后端**，
 * 使得刷新、断线、崩溃之后还能把未完成的任务捡回来。
 *
 * 因此所有调用都是 **best-effort**：
 * - 后端不可用 / 401 / 网络断 → 全部静默吞掉，绝不能让群聊因此发不出话。
 * - 失败不影响任何内存语义，行为与改造前逐字节一致。
 *
 * ## 为什么必须旁路而不是替换
 *
 * 直接把队列搬到后端等于重写编排，前端与后端的时序、合并窗口、
 * A→B 防环语义都要重新对齐——那是有明确破坏性的改动。
 * 旁路做不到「更聪明」，但能做到「不丢」，且失败模式是退化成今天的样子。
 */

const PREFIX = '/api/dept-groups'

export type PersistedWakeJob = {
  job_id: string
  dept_id: string
  agent_code: string
  role_name: string
  goal: string
  depth: number
  chain_key: string
  steward_mode: boolean
  from_agent_name: string
  source_msg_id: string
  /**
   * 后端状态。注意语义差异：
   * - `queued` = 还没跑
   * - `running` = 已认领（**不代表还活着**，判活要看 heartbeat_at，见仓储层）
   */
  status: string
  attempts: number
  error: string
  enqueued_at: string
}

export type WakePersistTransport = {
  post: (path: string, body: unknown) => Promise<unknown>
  get: (path: string, query?: Record<string, string>) => Promise<unknown>
}

export type WakePersistOpts = {
  transport: WakePersistTransport
  /** 开关，测试与排障用；默认开 */
  enabled?: boolean
  /** 失败回调（默认静默） */
  onError?: (where: string, err: unknown) => void
}

function isTrue(v: unknown): boolean {
  return v === true || v === 1
}

export class DeptGroupWakePersist {
  private readonly transport: WakePersistTransport
  private enabled: boolean
  private readonly onError?: (where: string, err: unknown) => void
  /** 已成功落库的 jobId，避免同一条重复打后端 */
  private readonly acked = new Set<string>()

  constructor(opts: WakePersistOpts) {
    this.transport = opts.transport
    this.enabled = opts.enabled !== false
    this.onError = opts.onError
  }

  setEnabled(v: boolean): void {
    this.enabled = v !== false
  }

  private fail(where: string, err: unknown): void {
    // 旁路失败绝不外抛：群聊主流程不依赖它。
    try {
      this.onError?.(where, err)
    } catch {
      /* ignore */
    }
  }

  /** 入队事实抄一份。幂等（后端按 job_id ON CONFLICT DO NOTHING）。 */
  async recordEnqueue(input: {
    jobId: string
    deptId: string
    agentCode: string
    roleName?: string
    goal?: string
    depth?: number
    chainKey?: string
    stewardMode?: boolean
    fromAgentName?: string
    sourceMsgId?: string
  }): Promise<boolean> {
    if (!this.enabled) return false
    const jobId = String(input.jobId || '').trim()
    const agentCode = String(input.agentCode || '').trim()
    if (!jobId || !agentCode) return false
    if (this.acked.has(jobId)) return true
    try {
      await this.transport.post(`${PREFIX}/wake-jobs/enqueue`, {
        job_id: jobId,
        dept_id: String(input.deptId || ''),
        agent_code: agentCode,
        role_name: String(input.roleName || ''),
        goal: String(input.goal || ''),
        depth: Number(input.depth) || 0,
        chain_key: String(input.chainKey || ''),
        steward_mode: isTrue(input.stewardMode),
        from_agent_name: String(input.fromAgentName || ''),
        source_msg_id: String(input.sourceMsgId || ''),
      })
      this.acked.add(jobId)
      return true
    } catch (e) {
      this.fail('enqueue', e)
      return false
    }
  }

  /** 状态推进。`requeue=true` 走退队重试（对方忙）。 */
  async recordStatus(input: {
    jobId: string
    status: 'queued' | 'running' | 'done' | 'failed'
    error?: string
    requeue?: boolean
  }): Promise<boolean> {
    if (!this.enabled) return false
    const jobId = String(input.jobId || '').trim()
    if (!jobId) return false
    try {
      await this.transport.post(`${PREFIX}/wake-jobs/status`, {
        job_id: jobId,
        status: String(input.status || ''),
        error: String(input.error || ''),
        requeue: isTrue(input.requeue),
      })
      return true
    } catch (e) {
      this.fail('status', e)
      return false
    }
  }

  async heartbeat(jobId: string): Promise<boolean> {
    if (!this.enabled) return false
    const jid = String(jobId || '').trim()
    if (!jid) return false
    try {
      await this.transport.post(`${PREFIX}/wake-jobs/heartbeat`, { job_id: jid })
      return true
    } catch (e) {
      this.fail('heartbeat', e)
      return false
    }
  }

  /**
   * 认领一条可跑的任务（恢复队列专用）。
   *
   * 【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
   * 为什么恢复必须「认领」而不是「直接重排」：页面每次挂载都会调恢复，
   * 直接重排 = 每开一次页面就重跑一轮（群里重复说话 + 重复计费）。
   * 认领在后端做 queued→running 状态迁移 + 同人串行检查，
   * 天然挡住「同一条任务被两个标签页各跑一遍」。
   *
   * 返回 null 表示没有可跑的（已跑完 / 别人正在跑且心跳新鲜）。
   */
  async claim(deptId: string, agentCode: string, owner = ''): Promise<PersistedWakeJob | null> {
    if (!this.enabled) return null
    const code = String(agentCode || '').trim()
    if (!code) return null
    try {
      const res = (await this.transport.post(`${PREFIX}/wake-jobs/claim`, {
        dept_id: String(deptId || ''),
        agent_code: code,
        owner,
      })) as { job?: unknown }
      const o = res?.job
      if (!o || typeof o !== 'object') return null
      const r = o as Record<string, unknown>
      const jobId = String(r.job_id || '').trim()
      if (!jobId) return null
      this.acked.add(jobId)
      return {
        job_id: jobId,
        dept_id: String(r.dept_id || ''),
        agent_code: String(r.agent_code || code),
        role_name: String(r.role_name || ''),
        goal: String(r.goal || ''),
        depth: Number(r.depth) || 0,
        chain_key: String(r.chain_key || ''),
        steward_mode: isTrue(r.steward_mode),
        from_agent_name: String(r.from_agent_name || ''),
        source_msg_id: String(r.source_msg_id || ''),
        status: String(r.status || 'running'),
        attempts: Number(r.attempts) || 0,
        error: String(r.error || ''),
        enqueued_at: String(r.enqueued_at || ''),
      }
    } catch (e) {
      this.fail('claim', e)
      return null
    }
  }

  /**
   * 取回未完成任务（刷新/重开后恢复）。
   *
   * 后端会在读路径顺手把心跳超时的 running 退回 queued，
   * 所以这里拿到的 `queued` 可能是「进程崩溃后被回收」的，
   * 恢复时要照常重排——不重排就等于永远不跑。
   */
  async loadPending(deptId: string): Promise<PersistedWakeJob[]> {
    if (!this.enabled) return []
    try {
      const res = (await this.transport.get(`${PREFIX}/wake-jobs/pending`, {
        dept_id: String(deptId || ''),
      })) as { jobs?: unknown }
      const raw = Array.isArray(res?.jobs) ? res.jobs : []
      const out: PersistedWakeJob[] = []
      for (const j of raw) {
        if (!j || typeof j !== 'object') continue
        const o = j as Record<string, unknown>
        const jobId = String(o.job_id || '').trim()
        const code = String(o.agent_code || '').trim()
        if (!jobId || !code) continue
        out.push({
          job_id: jobId,
          dept_id: String(o.dept_id || ''),
          agent_code: code,
          role_name: String(o.role_name || ''),
          goal: String(o.goal || ''),
          depth: Number(o.depth) || 0,
          chain_key: String(o.chain_key || ''),
          steward_mode: isTrue(o.steward_mode),
          from_agent_name: String(o.from_agent_name || ''),
          source_msg_id: String(o.source_msg_id || ''),
          status: String(o.status || 'queued'),
          attempts: Number(o.attempts) || 0,
          error: String(o.error || ''),
          enqueued_at: String(o.enqueued_at || ''),
        })
      }
      return out
    } catch (e) {
      this.fail('loadPending', e)
      return []
    }
  }

  /**
   * 把内存队列快照同步成后端状态（幂等、可反复调）。
   *
   * 只对**已落过库**的 jobId 生效：没 acked 的（比如恢复前就在队列里的历史任务）
   * 不去造新行，避免给后端塞一堆前端临时 id。
   */
  async syncSnapshot(
    jobs: { id: string; status: string; attempts?: number; error?: string }[],
  ): Promise<void> {
    if (!this.enabled) return
    const list = Array.isArray(jobs) ? jobs : []
    for (const j of list) {
      const id = String(j?.id || '').trim()
      if (!id || !this.acked.has(id)) continue
      const st = String(j.status || '')
      if (st !== 'done' && st !== 'failed') continue
      try {
        await this.recordStatus({
          jobId: id,
          status: st as 'done' | 'failed',
          error: String(j.error || ''),
        })
      } catch {
        /* recordStatus 已内部吞掉，这里只是兜底 */
      }
    }
  }
}

/** 旁路失败是否该重试：401/403/404 属于「后端没有这个路由」，重试无意义。 */
export function shouldRetryWakePersist(err: unknown): boolean {
  const status = Number((err as { status?: number })?.status) || 0
  if (status === 401 || status === 403 || status === 404) return false
  return true
}
