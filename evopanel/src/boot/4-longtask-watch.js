/**
 * 主线程长任务观测（loop-lag 护栏前端侧，对应 docs/design/v4-snapshot-slimming-and-loop-guards.md 4.3）。
 *
 * PerformanceObserver 采 longtask：>200ms 的主线程任务计数 + 采样入环形缓冲，
 * 节流 console.warn，并落盘 frontend-*.log（卡死时 console 常来不及看）。
 *
 * 开销：仅 observer 回调 + 数组 push，无 rAF 无轮询；报告节流 10s。
 * 诊断口：window.__dumpEvoflowLongtasks() 返回环形缓冲（最近 100 条）。
 *
 * 启动期一次性副作用，不放 init() 包装（同 3-recovery.js 约定）。
 */

const TASK_THRESHOLD_MS = 200
/** 单条 ≥1s 立即落盘，不等 10s 节流——对应「点发送后彻底卡死」对账。 */
const URGENT_MS = 1_000
const REPORT_INTERVAL_MS = 10_000
const RING_MAX = 100

const ring = []
let pendingCount = 0
let pendingMaxMs = 0
let lastReportAt = 0

function persistFrontendLog(level, message) {
  try {
    if (typeof window === 'undefined') return
    const w = window
    if (!(w.__TAURI__?.core?.invoke || w.__TAURI_INTERNALS__)) return
    void import('@tauri-apps/api/core')
      .then((m) => m.invoke('append_frontend_log', { level, message: String(message).slice(0, 11_500) }))
      .catch(() => {})
  } catch {
    /* best-effort */
  }
}

const report = (now) => {
  if (pendingCount === 0) return
  const summary = `[longtask] ${pendingCount} 个 >${TASK_THRESHOLD_MS}ms 主线程任务，最长 ${pendingMaxMs.toFixed(0)}ms`
  console.warn(summary)
  persistFrontendLog(pendingMaxMs >= URGENT_MS ? 'error' : 'warn', summary)
  pendingCount = 0
  pendingMaxMs = 0
  lastReportAt = now
}

try {
  if (typeof PerformanceObserver !== 'undefined') {
    const obs = new PerformanceObserver((list) => {
      const now = performance.now()
      for (const entry of list.getEntries()) {
        if (entry.duration < TASK_THRESHOLD_MS) continue
        pendingCount += 1
        if (entry.duration > pendingMaxMs) pendingMaxMs = entry.duration
        const sample = {
          at: Date.now(),
          durationMs: Math.round(entry.duration),
          name: entry.name,
          containerType: entry.containerType || undefined,
          containerName: entry.containerName || undefined,
          containerId: entry.containerId || undefined,
        }
        ring.push(sample)
        if (ring.length > RING_MAX) ring.shift()
        if (entry.duration >= URGENT_MS) {
          const line = `[longtask] urgent ${sample.durationMs}ms name=${sample.name || '?'} at=${new Date(sample.at).toISOString()}`
          console.error(line, sample)
          persistFrontendLog('error', `${line} ${JSON.stringify(sample)}`)
        }
      }
      if (now - lastReportAt >= REPORT_INTERVAL_MS) report(now)
    })
    obs.observe({ type: 'longtask', buffered: true })
  }
} catch {
  /* longtask 不支持（旧内核）则静默 */
}

window.__dumpEvoflowLongtasks = () => ring.slice()
