/**
 * 部门群聊：按人串行的轻量叫醒队列。
 * - 多人可并行；同一 agent 同时只跑一轮
 * - busy/409 入队重试，不丢
 * - 短窗口内同人近似目标合并
 */

export type WakeJobStatus = 'queued' | 'running' | 'done' | 'failed'

export type WakeJobSnapshot = {
  id: string
  agentCode: string
  roleName: string
  goal: string
  status: WakeJobStatus
  attempts: number
  error?: string
  /** 触发这条叫醒的消息（用于派工条对状态） */
  sourceMsgId?: string
  updatedAt: number
}

export type WakeEnqueueInput = {
  agentCode: string
  roleName: string
  goal: string
  depth: number
  fromAgentName?: string
  stewardMode?: boolean
  contextSummary?: string
  sourceMsgId?: string
  /** A→B 防环键；已存在则跳过 */
  chainKey?: string
}

export type WakeRunInput = WakeEnqueueInput & {
  jobId: string
  attempt: number
  signal: { aborted: boolean }
}

export type WakeRunResult = {
  /** 是否因对方忙需重试 */
  busy?: boolean
  error?: string
}

const MAX_ATTEMPTS = 4
const BUSY_BACKOFF_MS = [1500, 3000, 6000, 10000]
const MERGE_WINDOW_MS = 8000

export function isWakeBusyError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message || err || '')
  return /already running|正在巡检|正在工作|busy|执行任务|409/i.test(msg)
}

export function normalizeWakeGoal(goal: string): string {
  return String(goal || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 160)
}

type InternalJob = WakeEnqueueInput & {
  id: string
  status: WakeJobStatus
  attempts: number
  error?: string
  enqueuedAt: number
  updatedAt: number
  resolve: () => void
  reject: (e: unknown) => void
}

export type DeptGroupWakeQueueOpts = {
  run: (input: WakeRunInput) => Promise<WakeRunResult | void>
  onChange?: (jobs: WakeJobSnapshot[]) => void
  /** 测试可注入 */
  now?: () => number
  sleep?: (ms: number, signal: { aborted: boolean }) => Promise<void>
}

function defaultSleep(ms: number, signal: { aborted: boolean }): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    if (signal.aborted) {
      clearTimeout(t)
      resolve()
    }
  })
}

export class DeptGroupWakeQueue {
  private readonly run: DeptGroupWakeQueueOpts['run']
  private readonly onChange?: DeptGroupWakeQueueOpts['onChange']
  private readonly now: () => number
  private readonly sleep: (ms: number, signal: { aborted: boolean }) => Promise<void>
  private readonly queues = new Map<string, InternalJob[]>()
  private readonly pumping = new Set<string>()
  private readonly nestSeen = new Set<string>()
  private readonly all = new Map<string, InternalJob>()
  private aborted = false
  private seq = 0

  constructor(opts: DeptGroupWakeQueueOpts) {
    this.run = opts.run
    this.onChange = opts.onChange
    this.now = opts.now || (() => Date.now())
    this.sleep = opts.sleep || defaultSleep
  }

  reset() {
    this.aborted = false
    this.queues.clear()
    this.pumping.clear()
    this.nestSeen.clear()
    this.all.clear()
    this.emit()
  }

  dispose() {
    this.aborted = true
    for (const job of this.all.values()) {
      if (job.status === 'queued') {
        // 尚未开跑：直接取消
        job.status = 'failed'
        job.error = '已取消'
        job.updatedAt = this.now()
        job.reject(new Error('已取消'))
      }
      // running：不在这里 reject。等 execute 收尾——
      // run 已产出则 resolve（群气泡可落盘），否则再失败。
    }
    this.queues.clear()
    this.pumping.clear()
    this.emit()
  }

  snapshot(): WakeJobSnapshot[] {
    return [...this.all.values()]
      .map((j) => ({
        id: j.id,
        agentCode: j.agentCode,
        roleName: j.roleName,
        goal: j.goal,
        status: j.status,
        attempts: j.attempts,
        error: j.error,
        sourceMsgId: j.sourceMsgId,
        updatedAt: j.updatedAt,
      }))
      .sort((a, b) => a.updatedAt - b.updatedAt)
  }

  /** 按 agent 取最新一条活跃/终态任务（派工条用） */
  latestByAgent(agentCode: string, sourceMsgId?: string): WakeJobSnapshot | null {
    const code = String(agentCode || '').trim()
    if (!code) return null
    const rows = this.snapshot().filter((j) => {
      if (j.agentCode !== code) return false
      if (sourceMsgId && j.sourceMsgId && j.sourceMsgId !== sourceMsgId) return false
      return true
    })
    if (!rows.length) return null
    return rows[rows.length - 1]
  }

  enqueue(input: WakeEnqueueInput): Promise<void> {
    if (this.aborted) return Promise.reject(new Error('队列已关闭'))
    const agentCode = String(input.agentCode || '').trim()
    if (!agentCode) return Promise.reject(new Error('缺少员工'))
    const goal = String(input.goal || '').trim()
    if (!goal) return Promise.reject(new Error('缺少任务'))

    // 新一轮用户点名（depth=0）：清掉上一轮的嵌套防环，允许小V再次 @ 同一人
    // （旧逻辑成功后 nestSeen 永不释放 → 正式包里第二次 @技术总监 完全没气泡）
    if (Number(input.depth) === 0) {
      this.nestSeen.clear()
    }

    if (input.chainKey && this.nestSeen.has(input.chainKey)) {
      // 同轮内同链已叫醒过 → 跳过；失败会从 nestSeen 剔除，允许再试
      return Promise.resolve()
    }

    const norm = normalizeWakeGoal(goal)
    const now = this.now()
    const q = this.queues.get(agentCode) || []
    // 合并：同人、近似目标、仍在排队/执行中且落在合并窗口
    const mergeHit = q.find((j) => {
      if (j.status !== 'queued' && j.status !== 'running') return false
      if (normalizeWakeGoal(j.goal) !== norm) return false
      return now - j.enqueuedAt <= MERGE_WINDOW_MS
    })
    if (mergeHit) {
      // 保留更长目标（仅排队中可改；执行中已发出）
      if (mergeHit.status === 'queued' && goal.length > mergeHit.goal.length) {
        mergeHit.goal = goal
      }
      mergeHit.updatedAt = now
      this.emit()
      return new Promise((resolve, reject) => {
        const prevResolve = mergeHit.resolve
        const prevReject = mergeHit.reject
        mergeHit.resolve = () => {
          prevResolve()
          resolve()
        }
        mergeHit.reject = (e) => {
          prevReject(e)
          reject(e)
        }
      })
    }

    return new Promise((resolve, reject) => {
      const id = `wake-${agentCode}-${++this.seq}-${now}`
      const job: InternalJob = {
        ...input,
        agentCode,
        goal,
        id,
        status: 'queued',
        attempts: 0,
        enqueuedAt: now,
        updatedAt: now,
        resolve,
        reject,
      }
      this.all.set(id, job)
      const list = this.queues.get(agentCode) || []
      list.push(job)
      this.queues.set(agentCode, list)
      this.emit()
      void this.pump(agentCode)
    })
  }

  private emit() {
    try {
      this.onChange?.(this.snapshot())
    } catch {
      /* ignore */
    }
  }

  private async pump(agentCode: string) {
    if (this.aborted || this.pumping.has(agentCode)) return
    this.pumping.add(agentCode)
    try {
      while (!this.aborted) {
        const list = this.queues.get(agentCode) || []
        const job = list.find((j) => j.status === 'queued')
        if (!job) break
        await this.execute(job)
      }
    } finally {
      this.pumping.delete(agentCode)
    }
  }

  private async execute(job: InternalJob) {
    const signal = { aborted: this.aborted }
    // 开始执行时占坑，防止并行重复叫醒；失败再释放
    if (job.chainKey) {
      if (this.nestSeen.has(job.chainKey)) {
        job.status = 'done'
        job.updatedAt = this.now()
        this.emit()
        job.resolve()
        this.drop(job)
        return
      }
      this.nestSeen.add(job.chainKey)
    }
    while (!this.aborted) {
      job.status = 'running'
      job.attempts += 1
      job.updatedAt = this.now()
      job.error = undefined
      this.emit()

      try {
        const result = await this.run({
          jobId: job.id,
          attempt: job.attempts,
          agentCode: job.agentCode,
          roleName: job.roleName,
          goal: job.goal,
          depth: job.depth,
          fromAgentName: job.fromAgentName,
          stewardMode: job.stewardMode,
          contextSummary: job.contextSummary,
          sourceMsgId: job.sourceMsgId,
          signal,
        })
        // 跑完已有正文/定稿时，组件 dispose 不应再打成「已取消」
        // （员工 sticky 会话常已产出，只是群 UI 被重挂）
        if ((this.aborted || signal.aborted) && (result?.busy || result?.error)) {
          if (job.chainKey) this.nestSeen.delete(job.chainKey)
          job.status = 'failed'
          job.error = result.error || '已取消'
          job.updatedAt = this.now()
          this.emit()
          job.reject(new Error(job.error))
          this.drop(job)
          return
        }
        if (this.aborted || signal.aborted) {
          job.status = 'done'
          job.updatedAt = this.now()
          this.emit()
          job.resolve()
          this.drop(job)
          return
        }
        if (result?.busy) {
          if (job.attempts >= MAX_ATTEMPTS) {
            if (job.chainKey) this.nestSeen.delete(job.chainKey)
            job.status = 'failed'
            job.error = result.error || '对方持续忙碌'
            job.updatedAt = this.now()
            this.emit()
            job.reject(new Error(`对方持续忙碌：${job.error}`))
            this.drop(job)
            return
          }
          job.status = 'queued'
          job.error = result.error || '正忙，排队重试'
          job.updatedAt = this.now()
          this.emit()
          const wait = BUSY_BACKOFF_MS[Math.min(job.attempts - 1, BUSY_BACKOFF_MS.length - 1)]
          await this.sleep(wait, signal)
          continue
        }
        if (result?.error) {
          if (job.chainKey) this.nestSeen.delete(job.chainKey)
          job.status = 'failed'
          job.error = result.error
          job.updatedAt = this.now()
          this.emit()
          job.reject(new Error(result.error))
          this.drop(job)
          return
        }
        job.status = 'done'
        job.updatedAt = this.now()
        this.emit()
        job.resolve()
        this.drop(job)
        return
      } catch (e) {
        if (this.aborted) {
          if (job.chainKey) this.nestSeen.delete(job.chainKey)
          job.status = 'failed'
          job.error = '已取消'
          job.updatedAt = this.now()
          this.emit()
          job.reject(e)
          this.drop(job)
          return
        }
        if (isWakeBusyError(e) && job.attempts < MAX_ATTEMPTS) {
          job.status = 'queued'
          job.error = String((e as { message?: string })?.message || e || '正忙')
          job.updatedAt = this.now()
          this.emit()
          const wait = BUSY_BACKOFF_MS[Math.min(job.attempts - 1, BUSY_BACKOFF_MS.length - 1)]
          await this.sleep(wait, signal)
          continue
        }
        if (job.chainKey) this.nestSeen.delete(job.chainKey)
        job.status = 'failed'
        job.error = String((e as { message?: string })?.message || e || '失败')
        job.updatedAt = this.now()
        this.emit()
        job.reject(e)
        this.drop(job)
        return
      }
    }
  }

  private drop(job: InternalJob) {
    const list = this.queues.get(job.agentCode) || []
    this.queues.set(
      job.agentCode,
      list.filter((j) => j.id !== job.id),
    )
    // 保留终态快照一会儿给 UI；不从 all 删除，reset/dispose 时清
  }
}
