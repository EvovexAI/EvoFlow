/**
 * 部门群聊 @ 叫醒链路诊断（默认开启）。
 *
 * ## 落点（排查「@ 了人之后没动静」）
 * 1. DevTools Console：过滤 `[dept-group-wake]`
 * 2. 桌面端：`~/.evoflow/logs/frontend-YYYY-MM-DD.log`（`append_frontend_log`）
 *
 * 关闭：localStorage.setItem('EVOFLOW_DEPT_GROUP_WAKE_LOG', '0')
 */
const PREFIX = '[dept-group-wake]'
const LS_ENABLE_KEY = 'EVOFLOW_DEPT_GROUP_WAKE_LOG'
const RING_MAX = 120
const LS_RING_KEY = 'EVOFLOW_DEPT_GROUP_WAKE_RING'

export type DeptGroupWakeLogEvent =
  | 'send'
  | 'enqueue'
  | 'enqueue_skip'
  | 'enqueue_fail'
  | 'status'
  | 'bubble'
  | 'run_start'
  | 'activity'
  | 'first_delta'
  | 'run_done'
  | 'run_empty'
  | 'run_busy'
  | 'run_fail'
  | 'nest_enqueue'

export type DeptGroupWakeLogInput = {
  event: DeptGroupWakeLogEvent | string
  /** 给人看的中文说明（写进 frontend 日志主文案） */
  zh: string
  level?: 'info' | 'warn' | 'error'
  deptId?: string | null
  deptName?: string | null
  agentCode?: string | null
  roleName?: string | null
  jobId?: string | null
  sourceMsgId?: string | null
  detail?: Record<string, unknown>
}

type RingRec = {
  at: string
  event: string
  zh: string
  level: string
  deptId?: string
  agentCode?: string
  jobId?: string
  detail?: Record<string, unknown>
}

const ring: RingRec[] = []

function enabled(): boolean {
  try {
    if (typeof localStorage === 'undefined') return true
    return localStorage.getItem(LS_ENABLE_KEY) !== '0'
  } catch {
    return true
  }
}

function pushRing(rec: RingRec): void {
  ring.push(rec)
  while (ring.length > RING_MAX) ring.shift()
  try {
    if (typeof window !== 'undefined') {
      ;(window as unknown as { __evoflowDeptGroupWake?: RingRec[] }).__evoflowDeptGroupWake = [
        ...ring,
      ]
    }
  } catch {
    /* ignore */
  }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LS_RING_KEY, JSON.stringify(ring.slice(-40)))
    }
  } catch {
    /* ignore */
  }
}

/** 群聊 @ / 叫醒关键节点 → console + frontend-*.log */
export function logDeptGroupWake(input: DeptGroupWakeLogInput): void {
  if (!enabled()) return
  const level = input.level || 'info'
  const at = new Date().toISOString()
  const event = String(input.event || '').trim() || 'event'
  const zh = String(input.zh || '').trim() || event
  const deptId = String(input.deptId || '').trim() || undefined
  const agentCode = String(input.agentCode || '').trim() || undefined
  const jobId = String(input.jobId || '').trim() || undefined
  const payload: Record<string, unknown> = {
    at,
    event,
    zh,
    deptId,
    deptName: String(input.deptName || '').trim() || undefined,
    agentCode,
    roleName: String(input.roleName || '').trim() || undefined,
    jobId,
    sourceMsgId: String(input.sourceMsgId || '').trim() || undefined,
    ...(input.detail || {}),
  }
  const line = `${PREFIX} ${zh} | ${JSON.stringify(payload)}`
  try {
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.info(line)
  } catch {
    /* ignore */
  }
  pushRing({
    at,
    event,
    zh,
    level,
    deptId,
    agentCode,
    jobId,
    detail: input.detail,
  })
  try {
    void import('../../lib/tauri-api.js')
      .then((m) => m.appendFrontendLog?.(level, line.slice(0, 11_500)))
      .catch(() => {})
  } catch {
    /* ignore */
  }
}

export function getDeptGroupWakeLogRing(): RingRec[] {
  return [...ring]
}
