/**
 * In-browser responsiveness probe: long tasks, frame pacing, input latency.
 * Used by Playwright bench — no backend / SSE required when paired with bench page.
 */
import { getClientPerfSnapshot, percentile, resetClientPerf } from './client-perf.js'
import { publishLiveStream } from './live-stream-store.js'
import { setLiveStreamPathEnabled } from './stream-live-path-toggle.js'

export const BROWSER_PERF_BUDGETS = {
  longTasksMax: 5,
  longTaskSingleMaxMs: 500,
  frameP95Ms: 100,
  slowFramePctMax: 15,
  inputLatencyP95Ms: 200,
  streamBenchDeltaCount: 600,
} as const

/**
 * Stress gates for multi-minute / multi-kilo-delta runs.
 * Absolute longTask counts grow with wall time — gate per-1k-delta + max single task.
 */
export const BROWSER_STRESS_BUDGETS = {
  longTasksMax: 25,
  /** Soft cap when duration is short; long runs use longTasksPerKiloDeltaMax */
  longTaskSingleMaxMs: 2000,
  frameP95Ms: 250,
  slowFramePctMax: 45,
  inputLatencyP95Ms: 500,
  displayTickMax: 0,
  /** Main stress invariant: long tasks must not explode with delta count */
  longTasksPerKiloDeltaMax: 40,
} as const

export const BROWSER_DUAL_SESSION_BUDGETS = {
  longTasksMax: 10,
  longTaskSingleMaxMs: 600,
  frameP95Ms: 120,
  slowFramePctMax: 20,
  inputLatencyP95Ms: 250,
  switchInputP95Ms: 280,
  displayTickMax: 0,
} as const

export type DualSessionSwitchBenchOpts = {
  sessionA?: string
  sessionB?: string
  switchCount?: number
  deltasPerBurst?: number
  probeInputDuring?: boolean
}

export type DualSessionSwitchBenchResult = BrowserBenchResult & {
  sessionA: string
  sessionB: string
  switchCount: number
  switchInputP95Ms?: number
}

function switchDualSessionBench(which: 'a' | 'b'): void {
  if (typeof window.__benchDualSessionSwitch === 'function') {
    window.__benchDualSessionSwitch(which)
    return
  }
  document.getElementById(which === 'a' ? 'bench-switch-a' : 'bench-switch-b')?.click()
}

declare global {
  interface Window {
    __benchDualSessionSwitch?: (which: 'a' | 'b') => void
  }
}

export type BrowserBenchOpts = {
  sessionKey?: string
  deltaCount?: number
  chunkChars?: number
  probeInputDuring?: boolean
  livePath?: boolean
  /** Larger runs: probe/input + rAF less often to finish in reasonable wall time */
  stress?: boolean
  /** Cap publish rate (chunks/sec) to mimic real SSE instead of max flood */
  chunksPerSec?: number
  /**
   * Keep only trailing N chars in the live snapshot (virtualized stream tail).
   * Isolates LiveStream routing cost from unbounded markdown DOM growth.
   * Default: unlimited; stress rate-limited runs should pass ~4096.
   */
  tailChars?: number
}

export type BrowserBenchResult = {
  deltaCount: number
  durationMs: number
  longTasks: number
  longTaskMaxMs: number
  frameP95Ms: number
  slowFramePct: number
  inputLatencyP95Ms?: number
  displayTickBumps: number
  liveStreamPublishes: number
  /** How many publishLiveStream calls were made (may exceed store notifies if deduped). */
  publishAttempts: number
  livePathEnabled: boolean
  chunksPerSec?: number
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

export class BrowserPerfProbe {
  private longTasks = 0
  private longTaskMax = 0
  private frames: number[] = []
  private slowFrames = 0
  private inputLatencies: number[] = []
  private disconnects: Array<() => void> = []
  private rafHandle = 0
  private lastFrameAt: number | null = null
  private running = false

  start(): void {
    if (this.running) return
    this.running = true
    this.longTasks = 0
    this.longTaskMax = 0
    this.frames = []
    this.slowFrames = 0
    this.inputLatencies = []
    this.lastFrameAt = null

    if (typeof PerformanceObserver !== 'undefined') {
      try {
        const lt = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            this.longTasks += 1
            if (entry.duration > this.longTaskMax) this.longTaskMax = entry.duration
          }
        })
        lt.observe({ type: 'longtask', buffered: true })
        this.disconnects.push(() => lt.disconnect())
      } catch {
        /* ignore */
      }
    }

    const loop = (ts: number) => {
      if (!this.running) return
      if (this.lastFrameAt != null) {
        const dur = ts - this.lastFrameAt
        if (this.frames.length < 8192) this.frames.push(dur)
        else if (this.frames.length % 2 === 0) this.frames.push(dur)
        if (this.frames.length > 8192) this.frames.shift()
        if (dur > 33.4) this.slowFrames += 1
      }
      this.lastFrameAt = ts
      this.rafHandle = requestAnimationFrame(loop)
    }
    this.rafHandle = requestAnimationFrame(loop)
  }

  stop(): void {
    this.running = false
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle)
    this.rafHandle = 0
    for (const d of this.disconnects) d()
    this.disconnects = []
  }

  async probeInput(target?: Element | null): Promise<number> {
    const t0 = now()
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })
    const latency = Math.max(0, now() - t0)
    if (this.inputLatencies.length < 256) this.inputLatencies.push(latency)
    try {
      const el = target || document.body
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 8, clientY: 8 }))
      el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 8, clientY: 8 }))
    } catch {
      /* ignore */
    }
    return latency
  }

  snapshot(): Pick<
    BrowserBenchResult,
    'longTasks' | 'longTaskMaxMs' | 'frameP95Ms' | 'slowFramePct' | 'inputLatencyP95Ms'
  > {
    const frameP95Ms = percentile(this.frames, 95) ?? 0
    const slowFramePct =
      this.frames.length > 0 ? (this.slowFrames / this.frames.length) * 100 : 0
    return {
      longTasks: this.longTasks,
      longTaskMaxMs: Math.round(this.longTaskMax * 10) / 10,
      frameP95Ms: Math.round(frameP95Ms * 10) / 10,
      slowFramePct: Math.round(slowFramePct * 10) / 10,
      inputLatencyP95Ms: percentile(this.inputLatencies, 95),
    }
  }
}

export function checkBrowserBenchBudgets(
  result: BrowserBenchResult,
  budgets: typeof BROWSER_PERF_BUDGETS = BROWSER_PERF_BUDGETS,
): { ok: boolean; failures: string[] } {
  const failures: string[] = []
  if (result.longTasks > budgets.longTasksMax) {
    failures.push(`longTasks ${result.longTasks} > ${budgets.longTasksMax}`)
  }
  if (result.longTaskMaxMs > budgets.longTaskSingleMaxMs) {
    failures.push(
      `longTaskMaxMs ${result.longTaskMaxMs} > ${budgets.longTaskSingleMaxMs}`,
    )
  }
  if (result.frameP95Ms > budgets.frameP95Ms) {
    failures.push(`frameP95Ms ${result.frameP95Ms} > ${budgets.frameP95Ms}`)
  }
  if (result.slowFramePct > budgets.slowFramePctMax) {
    failures.push(`slowFramePct ${result.slowFramePct} > ${budgets.slowFramePctMax}`)
  }
  if (
    result.inputLatencyP95Ms != null &&
    result.inputLatencyP95Ms > budgets.inputLatencyP95Ms
  ) {
    failures.push(
      `inputLatencyP95Ms ${result.inputLatencyP95Ms} > ${budgets.inputLatencyP95Ms}`,
    )
  }
  const tickMax = 'displayTickMax' in budgets ? budgets.displayTickMax : 0
  if (result.livePathEnabled && result.displayTickBumps > tickMax) {
    failures.push(`displayTickBumps ${result.displayTickBumps} > ${tickMax} on live path`)
  }
  return { ok: failures.length === 0, failures }
}

export function checkBrowserStressBudgets(result: BrowserBenchResult): { ok: boolean; failures: string[] } {
  const failures: string[] = []
  const b = BROWSER_STRESS_BUDGETS
  if (result.livePathEnabled && result.displayTickBumps > b.displayTickMax) {
    failures.push(`displayTickBumps ${result.displayTickBumps} > ${b.displayTickMax}`)
  }
  if (result.longTaskMaxMs > b.longTaskSingleMaxMs) {
    failures.push(`longTaskMaxMs ${result.longTaskMaxMs} > ${b.longTaskSingleMaxMs}`)
  }
  if (result.frameP95Ms > b.frameP95Ms) {
    failures.push(`frameP95Ms ${result.frameP95Ms} > ${b.frameP95Ms}`)
  }
  if (result.slowFramePct > b.slowFramePctMax) {
    failures.push(`slowFramePct ${result.slowFramePct} > ${b.slowFramePctMax}`)
  }
  if (
    result.inputLatencyP95Ms != null &&
    result.inputLatencyP95Ms > b.inputLatencyP95Ms
  ) {
    failures.push(`inputLatencyP95Ms ${result.inputLatencyP95Ms} > ${b.inputLatencyP95Ms}`)
  }
  const kilo = Math.max(1, result.deltaCount / 1000)
  const perKilo = result.longTasks / kilo
  if (perKilo > b.longTasksPerKiloDeltaMax) {
    failures.push(
      `longTasksPerKiloDelta ${perKilo.toFixed(1)} > ${b.longTasksPerKiloDeltaMax} (total ${result.longTasks} / ${result.deltaCount} deltas)`,
    )
  }
  return { ok: failures.length === 0, failures }
}

export function checkBrowserDualSessionBudgets(
  result: DualSessionSwitchBenchResult,
  budgets: typeof BROWSER_DUAL_SESSION_BUDGETS = BROWSER_DUAL_SESSION_BUDGETS,
): { ok: boolean; failures: string[] } {
  const base = checkBrowserBenchBudgets(result, budgets)
  const failures = [...base.failures]
  if (
    result.switchInputP95Ms != null &&
    result.switchInputP95Ms > budgets.switchInputP95Ms
  ) {
    failures.push(
      `switchInputP95Ms ${result.switchInputP95Ms} > ${budgets.switchInputP95Ms}`,
    )
  }
  return { ok: failures.length === 0, failures }
}

/** Flood live-stream store while React MessageRow is mounted; measure frames/long tasks. */
export async function runBrowserStreamBench(opts?: BrowserBenchOpts): Promise<BrowserBenchResult> {
  const sk = String(opts?.sessionKey || 'bench-stream-perf').trim()
  const deltaCount = opts?.deltaCount ?? BROWSER_PERF_BUDGETS.streamBenchDeltaCount
  const chunkChars = opts?.chunkChars ?? 12
  const livePath = opts?.livePath ?? true
  const stress = !!opts?.stress
  const rate = opts?.chunksPerSec && opts.chunksPerSec > 0 ? opts.chunksPerSec : 0
  const probeEvery = stress ? Math.max(80, Math.floor(deltaCount / 40)) : 40
  const rafEvery = rate > 0 ? 1 : stress ? 8 : 3
  const msPerChunk = rate > 0 ? 1000 / rate : 0

  resetClientPerf()
  setLiveStreamPathEnabled(livePath)

  const probe = new BrowserPerfProbe()
  probe.start()
  const startedAt = now()
  let text = 'Bench stream seed.\n\n'
  let nextAt = startedAt
  const tailChars = opts?.tailChars && opts.tailChars > 0 ? opts.tailChars : 0
  let publishAttempts = 0

  for (let i = 0; i < deltaCount; i += 1) {
    if (msPerChunk > 0) {
      nextAt += msPerChunk
      const wait = nextAt - now()
      if (wait > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, wait))
      }
    }
    // Unique per delta so sliding-window publishes are never store-deduped.
    text += `Δ${i} `
    if (text.length % 47 === 0) text += '**md** '
    const publishText = tailChars > 0 && text.length > tailChars ? text.slice(-tailChars) : text
    publishAttempts += 1
    publishLiveStream(sk, { text: publishText, streaming: true })
    if (opts?.probeInputDuring && i > 0 && i % probeEvery === 0) {
      await probe.probeInput(document.getElementById('bench-probe-target'))
    }
    if (msPerChunk <= 0 && i % rafEvery === 0) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve())
      })
    } else if (msPerChunk > 0 && i % 4 === 0) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve())
      })
    }
  }

  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
  probe.stop()

  const snap = getClientPerfSnapshot()
  const metrics = probe.snapshot()
  return {
    deltaCount,
    durationMs: Math.round(now() - startedAt),
    ...metrics,
    displayTickBumps: snap.displayTickBumps,
    liveStreamPublishes: snap.liveStreamPublishes,
    publishAttempts,
    livePathEnabled: livePath,
    chunksPerSec: rate > 0 ? rate : undefined,
  }
}

/** Navigate away from chat surface while flooding (whole-client background cost). */
export async function runBrowserRouteSwitchBench(opts?: {
  sessionKey?: string
  deltaCount?: number
}): Promise<BrowserBenchResult & { route: string }> {
  const sk = String(opts?.sessionKey || 'bench-stream-perf').trim()
  const probe = new BrowserPerfProbe()
  probe.start()
  resetClientPerf()
  setLiveStreamPathEnabled(true)

  let text = 'Background stream while off chat.\n\n'
  const deltaCount = opts?.deltaCount ?? 300
  const targetRoute = '#/tasks'

  window.location.hash = targetRoute
  await new Promise<void>((r) => requestAnimationFrame(() => r()))

  const startedAt = now()
  for (let i = 0; i < deltaCount; i += 1) {
    text += 'bg '
    publishLiveStream(sk, { text, streaming: true })
    if (i % 30 === 0) await probe.probeInput(document.body)
    if (i % 3 === 0) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
  }

  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
  probe.stop()

  const snap = getClientPerfSnapshot()
  return {
    route: targetRoute,
    deltaCount,
    durationMs: Math.round(now() - startedAt),
    ...probe.snapshot(),
    displayTickBumps: snap.displayTickBumps,
    liveStreamPublishes: snap.liveStreamPublishes,
    publishAttempts: deltaCount,
    livePathEnabled: true,
  }
}

/** Flood two sessions while alternating visible MessageRow (session switch cost). */
export async function runBrowserDualSessionSwitchBench(
  opts?: DualSessionSwitchBenchOpts,
): Promise<DualSessionSwitchBenchResult> {
  const skA = String(opts?.sessionA || 'bench-dual-a').trim()
  const skB = String(opts?.sessionB || 'bench-dual-b').trim()
  const switchCount = opts?.switchCount ?? 10
  const deltasPerBurst = opts?.deltasPerBurst ?? 48
  const probeDuring = opts?.probeInputDuring ?? true

  resetClientPerf()
  setLiveStreamPathEnabled(true)

  const probe = new BrowserPerfProbe()
  probe.start()
  const switchInputLatencies: number[] = []
  let active: 'a' | 'b' = 'a'
  let textA = 'Session A seed.\n\n'
  let textB = 'Session B seed.\n\n'
  let publishAttempts = 0
  const startedAt = now()

  for (let s = 0; s < switchCount; s += 1) {
    for (let i = 0; i < deltasPerBurst; i += 1) {
      textA += `A${s}:${i} `
      textB += `B${s}:${i} `
      if (textA.length % 41 === 0) textA += '**md** '
      if (textB.length % 43 === 0) textB += '**md** '
      publishAttempts += 2
      publishLiveStream(skA, { text: textA, streaming: true })
      publishLiveStream(skB, { text: textB, streaming: true })
      if (probeDuring && i > 0 && i % 16 === 0) {
        await probe.probeInput(document.getElementById('bench-probe-target'))
      }
      if (i % 3 === 0) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      }
    }

    active = active === 'a' ? 'b' : 'a'
    switchDualSessionBench(active)
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
    const switchLat = await probe.probeInput(document.getElementById('bench-probe-target'))
    switchInputLatencies.push(switchLat)
  }

  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
  probe.stop()

  const snap = getClientPerfSnapshot()
  const metrics = probe.snapshot()
  return {
    sessionA: skA,
    sessionB: skB,
    switchCount,
    switchInputP95Ms: percentile(switchInputLatencies, 95),
    deltaCount: publishAttempts,
    durationMs: Math.round(now() - startedAt),
    ...metrics,
    displayTickBumps: snap.displayTickBumps,
    liveStreamPublishes: snap.liveStreamPublishes,
    publishAttempts,
    livePathEnabled: true,
  }
}
