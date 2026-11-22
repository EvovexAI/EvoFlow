/**
 * WebView2 / Chromium renderer 内存水位。
 *
 * 多轮对话后「错误代码: Out of Memory」是渲染进程被系统杀掉（sad tab），
 * 不是业务禁止多轮。这里用 `performance.memory`（Chromium 专有）估水位，
 * 供投影软顶 / pin / keep-warm 在高压时主动收缩，避免撑到崩溃。
 *
 * 读不到 heap 时退回 `normal`（Web / 旧内核），不误杀能力。
 */

export type RendererMemoryLevel = 'normal' | 'high' | 'critical'

/**
 * 必须远早于 WebView2 杀进程阈值动手。
 * 实测 2026-11-17：critical@768 时 heap 已 2.3–3.1GB 仍「每次只挤 2 条」，最终 Out of Memory。
 * high@384 / critical@512：给收缩留出几十秒窗口，而不是等到 sad tab。
 */
const HIGH_HEAP_MB = 384
const CRITICAL_HEAP_MB = 512

type HeapSnap = { usedJSHeapSize: number; totalJSHeapSize?: number }

function readHeap(): HeapSnap | null {
  try {
    if (typeof performance === 'undefined') return null
    const mem = (performance as Performance & { memory?: HeapSnap }).memory
    if (!mem || typeof mem.usedJSHeapSize !== 'number') return null
    return mem
  } catch {
    return null
  }
}

export function readRendererHeapMb(): number | null {
  const heap = readHeap()
  if (!heap) return null
  return heap.usedJSHeapSize / (1024 * 1024)
}

export function resolveRendererMemoryLevel(heapMb?: number | null): RendererMemoryLevel {
  const mb = heapMb == null ? readRendererHeapMb() : heapMb
  if (mb == null || !Number.isFinite(mb)) return 'normal'
  if (mb >= CRITICAL_HEAP_MB) return 'critical'
  if (mb >= HIGH_HEAP_MB) return 'high'
  return 'normal'
}

/** 投影 rows.window 软顶：高压时更狠，保住多轮「还能聊」而不是整页 OOM。 */
export function projectionSoftCapForMemoryLevel(level: RendererMemoryLevel): number {
  if (level === 'critical') return 50
  if (level === 'high') return 100
  // 正常 220：更早的行仍可通过上滚 loadOlder 拉回；常驻 400 行在长流式下仍易把 heap 顶穿。
  return 220
}

/** 后台 pin 会话数上限。normal 收紧到 4；high=2；critical=1。 */
export function pinMaxForMemoryLevel(level: RendererMemoryLevel): number {
  if (level === 'critical') return 1
  if (level === 'high') return 2
  return 6
}

/** 内存巡检间隔：危急时 2s 一轮，别等 15s 才挤一次。 */
export function memoryWatchIntervalMs(level: RendererMemoryLevel): number {
  if (level === 'critical') return 2_000
  if (level === 'high') return 5_000
  return 15_000
}

/** 旧工具卡保留完整载荷的尾窗行数。 */
export function heavyHorizonForMemoryLevel(level: RendererMemoryLevel): number {
  if (level === 'critical') return 20
  if (level === 'high') return 36
  return 60
}

let lastLoggedLevel: RendererMemoryLevel | null = null
let lastLoggedAt = 0
/** 上一次采样的 heap MB，供 critical 渐进驱逐判断「是否仍在涨」。 */
let lastHeapMbSample: number | null = null

/**
 * critical 水位是否还应继续挤 keep-warm：
 * - 读不到 heap → 保守继续挤
 * - heap 比上次采样仍升（或持平偏高）→ 继续
 * - heap 已回落 → 停手，避免无意义全灭导致切回冷开
 */
export function shouldContinueCriticalEviction(heapMb?: number | null): boolean {
  const mb = heapMb == null ? readRendererHeapMb() : heapMb
  if (mb == null || !Number.isFinite(mb)) return true
  const prev = lastHeapMbSample
  lastHeapMbSample = mb
  if (prev == null) return true
  // 允许 8MB 抖动；明显回落则停。
  return mb >= prev - 8
}

/** 水位变化或每 30s 打一行，落 frontend 日志便于对账 OOM。 */
export function noteRendererMemoryPressure(detail?: Record<string, unknown>): RendererMemoryLevel {
  const heapMb = readRendererHeapMb()
  if (heapMb != null && Number.isFinite(heapMb)) {
    lastHeapMbSample = heapMb
  }
  const level = resolveRendererMemoryLevel(heapMb)
  const now = Date.now()
  const changed = level !== lastLoggedLevel
  const due = now - lastLoggedAt >= 30_000
  if (!changed && !due) return level
  lastLoggedLevel = level
  lastLoggedAt = now
  if (level === 'normal' && !changed) return level
  const payload = {
    level,
    heapMb: heapMb != null ? Math.round(heapMb) : null,
    ...(detail || {}),
  }
  const line = `[mem-pressure] level=${level} heapMb=${payload.heapMb ?? '?'}`
  // critical is expected under long chats (we shrink keep-warm); don't flood
  // frontend-*.log as ERROR — reserve error for real JS / stream failures.
  if (level === 'critical' || level === 'high') console.warn(line, payload)
  else console.info(line, payload)
  try {
    if (typeof window === 'undefined') return level
    const w = window as Window & {
      __TAURI__?: { core?: { invoke?: unknown } }
      __TAURI_INTERNALS__?: unknown
    }
    if (!(w.__TAURI__?.core?.invoke || w.__TAURI_INTERNALS__)) return level
    void import('@tauri-apps/api/core')
      .then((m) =>
        m.invoke('append_frontend_log', {
          level: level === 'normal' ? 'info' : 'warn',
          message: `${line} ${JSON.stringify(payload)}`.slice(0, 11_500),
        }),
      )
      .catch(() => {})
  } catch {
    /* best-effort */
  }
  return level
}
