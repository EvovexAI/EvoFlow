/**
 * 工作流节点状态日志：把「节点上显示什么」原样打进控制台。
 *
 * 目的：出问题时能事后复盘 —— 什么时间点、哪个任务、哪个节点、显示了哪条内容。
 *
 * 每条日志都带：
 * - 时间戳（毫秒精度）
 * - 主任务名 + 主任务 ID（哪个任务）
 * - 子任务名 + 子任务 ID（哪个节点）
 * - 节点**实际渲染出来的**那一行文本（不是原始数据）
 *
 * 默认关闭。开启方式：
 *   localStorage.setItem('EVOFLOW_WORKFLOW_NODE_LOG', '1')
 * 或临时：
 *   window.__evoflowWorkflowNodeLog = true
 *
 * 日志前缀 `[wf-node]`，方便在 DevTools 里过滤。
 */

const STORAGE_KEY = 'EVOFLOW_WORKFLOW_NODE_LOG'

/** 同一节点的相同内容不重复刷屏（避免 2s 轮询把控制板刷爆） */
const DEDUP_TTL_MS = 1500
const lastSeen = new Map<string, number>()

export function isWorkflowNodeLogEnabled(): boolean {
  try {
    if (typeof window !== 'undefined' && (window as any).__evoflowWorkflowNodeLog) return true
    if (typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === '1') return true
  } catch {
    /* ignore */
  }
  return false
}

/** 打开日志（调试用）。 */
export function enableWorkflowNodeLog(): void {
  try {
    localStorage.setItem(STORAGE_KEY, '1')
  } catch {
    /* ignore */
  }
  if (typeof window !== 'undefined') (window as any).__evoflowWorkflowNodeLog = true
  console.info('[wf-node-toggle] 日志已开启')
}

export function disableWorkflowNodeLog(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
  if (typeof window !== 'undefined') (window as any).__evoflowWorkflowNodeLog = false
  // 用不同前缀，避免混进 [wf-node] 节点状态日志流
  console.info('[wf-node-toggle] 日志已关闭')
}

function timestamp(): string {
  const d = new Date()
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  )
}

export type WorkflowNodeLogEntry = {
  /** 主任务名 */
  taskName: string
  /** 主任务 ID */
  taskId: string
  /** 子任务名（节点标题） */
  nodeName: string
  /** 子任务 ID */
  subtaskId: string
  /** 节点状态（原始值） */
  status: string
  /** 节点状态（中文） */
  statusLabel: string
  /** 进度百分比 */
  progress: number | null
  /** 节点第二行**实际显示**的文本 */
  display: string
  /** 第二行是工具还是正文 */
  kind: 'tool' | 'text' | 'none'
  /** 正在跑的工具名 */
  activeTool: string
}

/**
 * 打印一条节点状态日志。
 * 内容与节点渲染完全一致 —— 「节点上显示什么，日志上就显示什么」。
 */
export function logWorkflowNodeState(entry: WorkflowNodeLogEntry): void {
  if (!isWorkflowNodeLogEnabled()) return

  // 去重：同一节点 + 同一显示内容，1.5s 内只打一次
  const key = `${entry.taskId}|${entry.subtaskId}|${entry.status}|${entry.display}`
  const now = Date.now()
  const prev = lastSeen.get(key)
  if (prev != null && now - prev < DEDUP_TTL_MS) return
  lastSeen.set(key, now)
  // 顺手清理过期项，避免 Map 无限增长
  if (lastSeen.size > 500) {
    for (const [k, t] of lastSeen) {
      if (now - t > DEDUP_TTL_MS * 4) lastSeen.delete(k)
    }
  }

  const pct = entry.progress == null ? '—' : `${entry.progress}%`
  console.info(
    `[wf-node] ${timestamp()} ` +
      `任务="${entry.taskName}" taskId=${entry.taskId || '—'} ` +
      `节点="${entry.nodeName}" subtaskId=${entry.subtaskId || '—'} ` +
      `状态=${entry.statusLabel}(${entry.status}) 进度=${pct} ` +
      `显示="${entry.display}"${entry.kind === 'tool' ? ' [工具]' : entry.kind === 'text' ? ' [正文]' : ''}`,
    entry.activeTool ? { activeTool: entry.activeTool } : undefined,
  )
}
