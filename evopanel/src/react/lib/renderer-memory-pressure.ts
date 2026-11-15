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

/** 约 512MB used → high；约 768MB → critical（WebView2 常见在 1–1.5GB 被杀）。 */
const HIGH_HEAP_MB = 512
const CRITICAL_HEAP_MB = 768

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
  if (level === 'critical') return 80
  if (level === 'high') return 140
  // 正常水位 400（2026-11-15 从 220 回撤）：220 会在长回合直播中把前面轮次裁出
  // 窗口（「历史记录看不到了」实锤）。行内重载荷已在服务端截断，400 行 ≈ 数 MB。
  return 400
}

/** 后台 pin 会话数上限。 */
export function pinMaxForMemoryLevel(level: RendererMemoryLevel): number {
  if (level === 'critical') return 1
  if (level === 'high') return 2
  return 4
}

let lastLoggedLevel: RendererMemoryLevel | null = null
let lastLoggedAt = 0

/** 水位变化或每 30s 打一行，落 frontend 日志便于对账 OOM。 */
export function noteRendererMemoryPressure(detail?: Record<string, unknown>): RendererMemoryLevel {
  const heapMb = readRendererHeapMb()
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
  if (level === 'critical') console.error(line, payload)
  else if (level === 'high') console.warn(line, payload)
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
          level: level === 'critical' ? 'error' : level === 'high' ? 'warn' : 'info',
          message: `${line} ${JSON.stringify(payload)}`.slice(0, 11_500),
        }),
      )
      .catch(() => {})
  } catch {
    /* best-effort */
  }
  return level
}
