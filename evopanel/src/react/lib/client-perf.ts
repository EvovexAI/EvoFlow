/**
 * Client-side UI performance counters (content-free).
 * Used by vitest regression gates and `window.__evopanelPerf` in the browser.
 */

export const CLIENT_PERF_BUDGETS = {
  /** Text-only stream: displayTick / delta should stay well below legacy (~1). */
  displayTickPerDeltaLiveMax: 0.05,
  /** Legacy path: each text delta bumps the list (≈1). */
  displayTickPerDeltaLegacyMin: 0.5,
  /** Live path should publish at least one live snapshot per stream. */
  livePublishesPerStreamMin: 1,
  longTasksPerTurnMax: 3,
  frameP95Ms: 33,
  inputLatencyP95Ms: 150,
} as const

export type ClientPerfSnapshot = {
  displayTickBumps: number
  liveStreamPublishes: number
  liveStreamRafFlushes: number
  sseTextDeltas: number
  sseStructuralEvents: number
  chatSurfaceVisible: boolean
  activeTurns: number
  lastTurnSummary: TurnPerfSummary | null
}

export type TurnPerfSummary = {
  sessionKey: string
  turnMs: number
  displayTickBumps: number
  liveStreamPublishes: number
  sseTextDeltas: number
  sseStructuralEvents: number
  longTasks: number
}

export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)]
}

let displayTickBumps = 0
let liveStreamPublishes = 0
let liveStreamRafFlushes = 0
let sseTextDeltas = 0
let sseStructuralEvents = 0
let chatSurfaceVisible = true
const chatSurfaceListeners = new Set<() => void>()
let lastTurnSummary: TurnPerfSummary | null = null

const activeTurns = new Map<
  string,
  {
    sessionKey: string
    startedAt: number
    displayTickBumps: number
    liveStreamPublishes: number
    sseTextDeltas: number
    sseStructuralEvents: number
    longTasks: number
  }
>()

let longTaskObserver: PerformanceObserver | null = null
const turnLongTasks = new Map<string, number>()

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function ensureLongTaskObserver(): void {
  if (longTaskObserver || typeof PerformanceObserver === 'undefined') return
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      const count = list.getEntries().length
      if (count === 0) return
      for (const turn of activeTurns.values()) {
        turn.longTasks += count
      }
    })
    longTaskObserver.observe({ type: 'longtask', buffered: true })
  } catch {
    longTaskObserver = null
  }
}

export function isClientPerfEnabled(): boolean {
  return isClientPerfHudEnabled()
}

/** HUD + counters — explicit opt-in only (not on by default in dev). */
export function isClientPerfHudEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const stored = localStorage.getItem('evopanel_client_perf')
    if (stored === '0') return false
    if (stored === '1') return true
  } catch {
    /* ignore */
  }
  try {
    const hash = String(window.location.hash || '')
    const hashQuery = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : ''
    if (new URLSearchParams(hashQuery).has('perf')) return true
    if (new URLSearchParams(window.location.search).has('perf')) return true
  } catch {
    /* ignore */
  }
  return false
}

export function setClientPerfHudEnabled(enabled: boolean): void {
  try {
    localStorage.setItem('evopanel_client_perf', enabled ? '1' : '0')
  } catch {
    /* ignore */
  }
}

export function resetClientPerf(): void {
  displayTickBumps = 0
  liveStreamPublishes = 0
  liveStreamRafFlushes = 0
  sseTextDeltas = 0
  sseStructuralEvents = 0
  chatSurfaceVisible = true
  lastTurnSummary = null
  activeTurns.clear()
  turnLongTasks.clear()
}

/** Test helper alias */
export const resetClientPerfForTests = resetClientPerf

export function getClientPerfSnapshot(): ClientPerfSnapshot {
  return {
    displayTickBumps,
    liveStreamPublishes,
    liveStreamRafFlushes,
    sseTextDeltas,
    sseStructuralEvents,
    chatSurfaceVisible,
    activeTurns: activeTurns.size,
    lastTurnSummary,
  }
}

export function getChatSurfaceVisible(): boolean {
  return chatSurfaceVisible
}

export function subscribeChatSurfaceVisible(onStoreChange: () => void): () => void {
  chatSurfaceListeners.add(onStoreChange)
  return () => {
    chatSurfaceListeners.delete(onStoreChange)
  }
}

export function setChatSurfaceVisible(visible: boolean): void {
  const next = !!visible
  if (next === chatSurfaceVisible) return
  chatSurfaceVisible = next
  for (const cb of chatSurfaceListeners) cb()
}

export function noteDisplayTickBump(): void {
  displayTickBumps += 1
  for (const turn of activeTurns.values()) turn.displayTickBumps += 1
}

export function noteLiveStreamPublish(): void {
  liveStreamPublishes += 1
  for (const turn of activeTurns.values()) turn.liveStreamPublishes += 1
}

export function noteLiveStreamRafFlush(): void {
  liveStreamRafFlushes += 1
}

export function noteSseTextDelta(): void {
  sseTextDeltas += 1
  for (const turn of activeTurns.values()) turn.sseTextDeltas += 1
}

export function noteSseStructuralEvent(): void {
  sseStructuralEvents += 1
  for (const turn of activeTurns.values()) turn.sseStructuralEvents += 1
}

export function startClientPerfTurn(sessionKey: string, turnId?: string): void {
  if (!isClientPerfEnabled()) return
  ensureLongTaskObserver()
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  const id = String(turnId || sk)
  activeTurns.set(id, {
    sessionKey: sk,
    startedAt: now(),
    displayTickBumps: 0,
    liveStreamPublishes: 0,
    sseTextDeltas: 0,
    sseStructuralEvents: 0,
    longTasks: turnLongTasks.get(id) || 0,
  })
}

export function endClientPerfTurn(turnId: string): TurnPerfSummary | null {
  const id = String(turnId || '').trim()
  if (!id) return null
  const turn = activeTurns.get(id)
  if (!turn) return null
  activeTurns.delete(id)
  const summary: TurnPerfSummary = {
    sessionKey: turn.sessionKey,
    turnMs: now() - turn.startedAt,
    displayTickBumps: turn.displayTickBumps,
    liveStreamPublishes: turn.liveStreamPublishes,
    sseTextDeltas: turn.sseTextDeltas,
    sseStructuralEvents: turn.sseStructuralEvents,
    longTasks: turn.longTasks,
  }
  lastTurnSummary = summary
  turnLongTasks.delete(id)
  return summary
}

/** Measure pointer → next frame latency (ms). Useful while streaming. */
export async function probeInputLatency(): Promise<number> {
  return new Promise((resolve) => {
    const t0 = now()
    requestAnimationFrame(() => {
      resolve(Math.max(0, now() - t0))
    })
    try {
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 1, clientY: 1 }))
    } catch {
      /* ignore */
    }
  })
}

export type BudgetCheck = { ok: boolean; failures: string[] }

export function checkStreamSimBudgets(result: {
  displayTickPerDelta: number
  livePublishes: number
  livePathEnabled: boolean
}): BudgetCheck {
  const failures: string[] = []
  if (result.livePathEnabled) {
    if (result.displayTickPerDelta > CLIENT_PERF_BUDGETS.displayTickPerDeltaLiveMax) {
      failures.push(
        `live displayTick/delta ${result.displayTickPerDelta.toFixed(3)} > ${CLIENT_PERF_BUDGETS.displayTickPerDeltaLiveMax}`,
      )
    }
    if (result.livePublishes < CLIENT_PERF_BUDGETS.livePublishesPerStreamMin) {
      failures.push(`live publishes ${result.livePublishes} < ${CLIENT_PERF_BUDGETS.livePublishesPerStreamMin}`)
    }
  } else if (result.displayTickPerDelta < CLIENT_PERF_BUDGETS.displayTickPerDeltaLegacyMin) {
    failures.push(
      `legacy displayTick/delta ${result.displayTickPerDelta.toFixed(3)} < ${CLIENT_PERF_BUDGETS.displayTickPerDeltaLegacyMin}`,
    )
  }
  return { ok: failures.length === 0, failures }
}
