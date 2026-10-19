/**
 * 流式渲染性能追踪：多维指标交叉定位卡顿根因。
 *
 * 指标维度：
 *   1. 耗时分解（各 phase ms）→ 哪个环节慢
 *   2. 重渲染行数 / 可见行数 → memo 是否生效
 *   3. delta 频率（次/秒）→ 是否渲染风暴
 *   4. 轮次恶化（当前 / 基线）→ 是否累积型
 *   5. 内存趋势 → GC 压力
 *
 * 开关：?streamperf=1 或 localStorage.evoflow_streamperf=1
 *   也可热开（无需 reload）：window.__streamPerf.enable()
 *   开启后：超阈值指标 + 2 秒心跳 → ring buffer → 5 秒批量 flush →
 *   Tauri append_frontend_log → log_dir()/frontend-YYYY-MM-DD.log
 *   （控制台不再刷屏；事后 grep "streamperf batch" 排查时间趋势）
 *   聚合：window.__streamPerf.report() 打各环节 p50/p95/max + 多维诊断（手动，仍走 console）
 *
 * 关闭时所有函数空操作，零开销。
 */

const PHASE_WARN_MS = 30
const DELTA_WARN_MS = 12
const SINGLE_ROW_DELTA_WARN_MS = 30
const WINDOW_SIZE = 200
const MEM_SAMPLE_INTERVAL = 50
const HEARTBEAT_MS = 2000
const REASONING_PAINT_WARN_MS = 8

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function detectEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const stored = localStorage.getItem('evoflow_streamperf')
    if (stored === '0') return false
    if (stored === '1') return true
  } catch {
    /* ignore */
  }
  try {
    if (new URLSearchParams(window.location.search).get('streamperf') === '1') return true
  } catch {
    /* ignore */
  }
  return false
}

let enabled = detectEnabled()

// === 文件日志：ring buffer + 5 秒批量 flush → Tauri append_frontend_log ===
// 控制台临时性，刷新即失；写文件可事后排查"10 分钟后卡顿"的时间趋势。
type PerfRecord = {
  ts: string
  kind: 'phase' | 'delta' | 'memo-fail' | 'degradation' | 'longtask' | 'heartbeat' | 'reasoning-paint'
  seq?: number
  total?: number
  render?: number
  visible?: number
  memo?: number
  degradation?: number
  phases?: Record<string, number>
  ctx?: StreamPerfLiveContext
  extra?: Record<string, unknown>
}

const perfBuffer: PerfRecord[] = []
const PERF_BUFFER_MAX = 800
const PERF_FLUSH_MS = 5000
let flushTimer: ReturnType<typeof setInterval> | null = null
let flushInFlight = false

function isoNow(): string {
  try { return new Date().toISOString() } catch { return String(Date.now()) }
}

function pushPerf(rec: PerfRecord): void {
  perfBuffer.push(rec)
  if (perfBuffer.length > PERF_BUFFER_MAX) {
    perfBuffer.splice(0, perfBuffer.length - PERF_BUFFER_MAX)
  }
  ensureFlushTimer()
}

function ensureFlushTimer(): void {
  if (flushTimer || typeof setInterval === 'undefined') return
  flushTimer = setInterval(() => { void flushPerfBuffer() }, PERF_FLUSH_MS)
}

// === 块边界 mark：long task 时报告"卡顿前最后一个 mark"，定位到哪一块 ===
let lastMarkAt = 0
let lastMarkName = ''

export function streamPerfMark(name: string): void {
  if (!enabled) return
  lastMarkAt = now()
  lastMarkName = name
}

async function flushPerfBuffer(): Promise<void> {
  if (flushInFlight || perfBuffer.length === 0) return
  flushInFlight = true
  const batch = perfBuffer.splice(0, perfBuffer.length)
  try {
    const json = JSON.stringify(batch)
    const mod = await import('../../lib/tauri-api.js') as unknown as {
      appendFrontendLog?: (level: string, msg: string) => void
    }
    if (typeof mod.appendFrontendLog === 'function') {
      mod.appendFrontendLog('warn', `streamperf batch: ${json}`)
    }
  } catch {
    perfBuffer.unshift(...batch)
    if (perfBuffer.length > PERF_BUFFER_MAX) {
      perfBuffer.splice(0, perfBuffer.length - PERF_BUFFER_MAX)
    }
  } finally {
    flushInFlight = false
  }
}

export type StreamPerfLiveContext = {
  historyRows?: number
  reasoningChars?: number
  textChars?: number
  toolCount?: number
  segmentCount?: number
  bumpScore?: number
  bumpIntervalMs?: number
  streamActive?: boolean
}

let liveContext: StreamPerfLiveContext = {}
let lastHeartbeatAt = 0
let deltasSinceHeartbeat = 0
let reasoningPaintSamples = 0
let reasoningPaintMaxMs = 0
let reasoningPaintSumMs = 0

type PhaseStats = {
  samples: number[]
  max: number
}

const phaseStats = new Map<string, PhaseStats>()
let currentDeltaPhases: Map<string, number> | null = null
let currentDeltaStart = 0
let currentDeltaSeq = -1

function ensureStats(phase: string): PhaseStats {
  let s = phaseStats.get(phase)
  if (!s) {
    s = { samples: [], max: 0 }
    phaseStats.set(phase, s)
  }
  return s
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}

let lastDeltaSeq = -1
let renderCountThisDelta = 0
let visibleRowCountThisDelta = 0
let deltaTimestamps: number[] = []
let baselineDeltaTotal = 0
let baselineDeltaSeq = -1
let memSamples: { seq: number; mb: number }[] = []
let memSampleCounter = 0

const renderCountStats = { samples: [] as number[], max: 0 }
const memoHitRateStats = { samples: [] as number[], max: 0 }

export function streamPerfSetEnabled(next: boolean): void {
  enabled = !!next
  try {
    localStorage.setItem('evoflow_streamperf', enabled ? '1' : '0')
  } catch {
    /* ignore */
  }
  if (enabled) {
    installLongTaskMonitor()
    lastHeartbeatAt = 0
    console.info(
      '[streamperf] ON（热开）— 日志写入 frontend 日志文件；report: __streamPerf.report(); off: __streamPerf.disable()',
    )
  } else {
    console.info('[streamperf] OFF')
    void flushPerfBuffer()
  }
}

/** 每帧由 MessageVirtualList 写入：历史长度 / 思考体量 / bump 节流，便于对照「越聊越卡」。 */
export function streamPerfNoteContext(partial: StreamPerfLiveContext): void {
  if (!enabled) return
  liveContext = { ...liveContext, ...partial }
}

/** 思考行渲染耗时（ReasoningInlineBlock / RunningScanText 路径）。 */
export function streamPerfNoteReasoningPaint(ms: number, chars: number): void {
  if (!enabled) return
  reasoningPaintSamples += 1
  reasoningPaintSumMs += ms
  if (ms > reasoningPaintMaxMs) reasoningPaintMaxMs = ms
  liveContext = { ...liveContext, reasoningChars: chars }
  if (ms > REASONING_PAINT_WARN_MS) {
    pushPerf({ ts: isoNow(), kind: 'reasoning-paint', extra: { ms: +ms.toFixed(1), chars } })
  }
}

export function streamPerfBeginDelta(seq: number): void {
  if (!enabled) return
  if (seq === lastDeltaSeq) {
    currentDeltaPhases = null
    return
  }
  lastDeltaSeq = seq
  currentDeltaPhases = new Map()
  currentDeltaStart = now()
  currentDeltaSeq = seq
  renderCountThisDelta = 0
  visibleRowCountThisDelta = 0
  deltasSinceHeartbeat += 1
}

export function streamPerfTime<T>(phase: string, fn: () => T): T {
  if (!enabled) return fn()
  const t0 = now()
  const result = fn()
  const ms = now() - t0
  if (currentDeltaPhases) {
    currentDeltaPhases.set(phase, (currentDeltaPhases.get(phase) || 0) + ms)
  }
  if (ms > PHASE_WARN_MS) {
    pushPerf({ ts: isoNow(), kind: 'phase', extra: { phase, ms: +ms.toFixed(1) } })
  }
  return result
}

export function streamPerfCountRender(): void {
  if (!enabled || !currentDeltaPhases) return
  renderCountThisDelta++
}

export function streamPerfSetVisibleRows(n: number): void {
  if (!enabled || !currentDeltaPhases) return
  visibleRowCountThisDelta = n
}

export function streamPerfEndDelta(): void {
  if (!enabled || !currentDeltaPhases) return
  const total = now() - currentDeltaStart

  for (const [phase, ms] of currentDeltaPhases) {
    const s = ensureStats(phase)
    s.samples.push(ms)
    if (s.samples.length > WINDOW_SIZE) s.samples.shift()
    if (ms > s.max) s.max = ms
  }

  renderCountStats.samples.push(renderCountThisDelta)
  if (renderCountStats.samples.length > WINDOW_SIZE) renderCountStats.samples.shift()
  if (renderCountThisDelta > renderCountStats.max) renderCountStats.max = renderCountThisDelta

  const memoHitRate =
    visibleRowCountThisDelta > 0
      ? 1 - renderCountThisDelta / visibleRowCountThisDelta
      : 1
  memoHitRateStats.samples.push(memoHitRate)
  if (memoHitRateStats.samples.length > WINDOW_SIZE) memoHitRateStats.samples.shift()

  deltaTimestamps.push(now())
  if (deltaTimestamps.length > WINDOW_SIZE) deltaTimestamps.shift()

  if (baselineDeltaTotal === 0 && total > 0 && total < DELTA_WARN_MS) {
    baselineDeltaTotal = total
    baselineDeltaSeq = currentDeltaSeq
  }

  memSampleCounter++
  if (memSampleCounter >= MEM_SAMPLE_INTERVAL) {
    memSampleCounter = 0
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
    if (mem) {
      memSamples.push({ seq: currentDeltaSeq, mb: mem.usedJSHeapSize / 1048576 })
      if (memSamples.length > WINDOW_SIZE) memSamples.shift()
    }
  }

  const degradation = baselineDeltaTotal > 0 ? total / baselineDeltaTotal : 1

  const isSingleRowRender = renderCountThisDelta <= 1
  const effectiveWarnMs = isSingleRowRender ? SINGLE_ROW_DELTA_WARN_MS : DELTA_WARN_MS
  if (total > effectiveWarnMs) {
    const breakdown: Record<string, number> = {}
    for (const [phase, ms] of currentDeltaPhases) breakdown[phase] = +ms.toFixed(1)
    pushPerf({
      ts: isoNow(),
      kind: 'delta',
      seq: currentDeltaSeq,
      total: +total.toFixed(1),
      render: renderCountThisDelta,
      visible: visibleRowCountThisDelta,
      memo: +memoHitRate.toFixed(2),
      degradation: +degradation.toFixed(1),
      phases: breakdown,
      ctx: { ...liveContext },
    })
  }

  if (
    visibleRowCountThisDelta > 0 &&
    renderCountThisDelta > visibleRowCountThisDelta * 0.8 &&
    renderCountThisDelta >= 5
  ) {
    pushPerf({
      ts: isoNow(),
      kind: 'memo-fail',
      seq: currentDeltaSeq,
      render: renderCountThisDelta,
      visible: visibleRowCountThisDelta,
      memo: +memoHitRate.toFixed(2),
    })
  }

  if (degradation > 3 && total > DELTA_WARN_MS && renderCountThisDelta > 1) {
    pushPerf({
      ts: isoNow(),
      kind: 'degradation',
      seq: currentDeltaSeq,
      total: +total.toFixed(1),
      degradation: +degradation.toFixed(1),
      extra: { baselineMs: +baselineDeltaTotal.toFixed(1), baselineSeq: baselineDeltaSeq },
    })
  }

  lastDeltaSnapshot = {
    seq: currentDeltaSeq,
    total: +total.toFixed(1),
    renderRows: renderCountThisDelta,
    visibleRows: visibleRowCountThisDelta,
    memoHitRate: +memoHitRate.toFixed(2),
    degradation: +degradation.toFixed(1),
    phases: Object.fromEntries(currentDeltaPhases),
    context: { ...liveContext },
  }
  currentDeltaPhases = null

  const tNow = now()
  if (tNow - lastHeartbeatAt >= HEARTBEAT_MS) {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
    const heapMb = mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : null
    const reasoningAvg =
      reasoningPaintSamples > 0 ? reasoningPaintSumMs / reasoningPaintSamples : 0
    pushPerf({
      ts: isoNow(),
      kind: 'heartbeat',
      seq: currentDeltaSeq,
      total: +total.toFixed(1),
      render: renderCountThisDelta,
      visible: visibleRowCountThisDelta,
      degradation: +degradation.toFixed(1),
      ctx: { ...liveContext },
      extra: {
        deltas: deltasSinceHeartbeat,
        heapMb,
        reasoningPaintAvgMs: +reasoningAvg.toFixed(2),
        reasoningPaintMaxMs: +reasoningPaintMaxMs.toFixed(1),
      },
    })
    lastHeartbeatAt = tNow
    deltasSinceHeartbeat = 0
    reasoningPaintSamples = 0
    reasoningPaintSumMs = 0
    reasoningPaintMaxMs = 0
  }
}

let lastDeltaSnapshot: {
  seq: number
  total: number
  renderRows: number
  visibleRows: number
  memoHitRate: number
  degradation: number
  phases: Record<string, number>
  context: StreamPerfLiveContext
} | null = null

let longTaskObserver: PerformanceObserver | null = null
function installLongTaskMonitor(): void {
  if (longTaskObserver || typeof PerformanceObserver === 'undefined') return
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const dur = entry.duration
        const snap = lastDeltaSnapshot
        if (snap && snap.visibleRows > 0) {
          pushPerf({
            ts: isoNow(),
            kind: 'longtask',
            seq: snap.seq,
            total: snap.total,
            render: snap.renderRows,
            visible: snap.visibleRows,
            degradation: snap.degradation,
            phases: snap.phases,
            extra: {
              durMs: +dur.toFixed(0),
              lastMark: lastMarkName || null,
              msSinceMark: lastMarkAt > 0 ? +(now() - lastMarkAt).toFixed(1) : null,
            },
          })
        }
      }
    })
    longTaskObserver.observe({ type: 'longtask', buffered: true })
  } catch {
    longTaskObserver = null
  }
}

export function streamPerfReport(): Record<string, unknown> {
  const phaseReport: Record<string, { p50: number; p95: number; max: number; count: number }> = {}
  for (const [phase, s] of phaseStats) {
    const sorted = [...s.samples].sort((a, b) => a - b)
    phaseReport[phase] = {
      p50: +percentile(sorted, 50).toFixed(1),
      p95: +percentile(sorted, 95).toFixed(1),
      max: +s.max.toFixed(1),
      count: s.samples.length,
    }
  }

  const renderSorted = [...renderCountStats.samples].sort((a, b) => a - b)
  const memoSorted = [...memoHitRateStats.samples].sort((a, b) => a - b)

  let deltaRate = 0
  if (deltaTimestamps.length >= 2) {
    const span = (deltaTimestamps[deltaTimestamps.length - 1] - deltaTimestamps[0]) / 1000
    deltaRate = span > 0 ? deltaTimestamps.length / span : 0
  }

  let memTrend: { start: number; end: number; growth: number } | null = null
  if (memSamples.length >= 2) {
    const start = memSamples[0]
    const end = memSamples[memSamples.length - 1]
    memTrend = {
      start: +start.mb.toFixed(1),
      end: +end.mb.toFixed(1),
      growth: +(end.mb - start.mb).toFixed(1),
    }
  }

  return {
    phases: phaseReport,
    renderRows: {
      p50: percentile(renderSorted, 50),
      p95: percentile(renderSorted, 95),
      max: renderCountStats.max,
      count: renderCountStats.samples.length,
    },
    memoHitRate: {
      p50: +percentile(memoSorted, 50).toFixed(2),
      p95: +percentile(memoSorted, 95).toFixed(2),
      count: memoHitRateStats.samples.length,
    },
    deltaRate: +deltaRate.toFixed(1),
    baseline: baselineDeltaTotal > 0 ? { seq: baselineDeltaSeq, total: +baselineDeltaTotal.toFixed(1) } : null,
    memTrend,
  }
}

export function streamPerfEnabled(): boolean {
  return enabled
}

export function streamPerfReset(): void {
  phaseStats.clear()
  renderCountStats.samples = []
  renderCountStats.max = 0
  memoHitRateStats.samples = []
  deltaTimestamps = []
  baselineDeltaTotal = 0
  baselineDeltaSeq = -1
  memSamples = []
  liveContext = {}
  lastHeartbeatAt = 0
  deltasSinceHeartbeat = 0
  reasoningPaintSamples = 0
  reasoningPaintSumMs = 0
  reasoningPaintMaxMs = 0
  perfBuffer.length = 0
}

export function installStreamPerfGlobal(): void {
  if (typeof window === 'undefined') return
  if (enabled) installLongTaskMonitor()
  const g = window as unknown as Record<string, unknown>
  g.__streamPerf = {
    report: () => {
      const r = streamPerfReport()
      console.table(r.phases)
      console.log('[streamperf] 诊断:', {
        renderRows: r.renderRows,
        memoHitRate: r.memoHitRate,
        deltaRate: r.deltaRate,
        baseline: r.baseline,
        memTrend: r.memTrend,
        liveContext,
      })
      return r
    },
    reset: streamPerfReset,
    enable: () => streamPerfSetEnabled(true),
    disable: () => streamPerfSetEnabled(false),
    flush: () => { void flushPerfBuffer() },
    enabled: () => enabled,
    lastDelta: () => lastDeltaSnapshot,
    context: () => ({ ...liveContext }),
  }
}