/**
 * Browser introspection: `window.__evopanelPerf`
 * Enable HUD: `?perf=1` or `localStorage.evopanel_client_perf = '1'`
 * Disable HUD: `localStorage.evopanel_client_perf = '0'` or `__evopanelPerf.hideHud()`
 */
import {
  CLIENT_PERF_BUDGETS,
  checkStreamSimBudgets,
  getClientPerfSnapshot,
  isClientPerfEnabled,
  isClientPerfHudEnabled,
  probeInputLatency,
  resetClientPerf,
  setClientPerfHudEnabled,
  type ClientPerfSnapshot,
} from './client-perf.js'
import {
  compareStreamPaths,
  simulateTextOnlyStream,
  type StreamPathCompare,
  type StreamSimResult,
} from './client-perf-scenarios.js'
import {
  BROWSER_PERF_BUDGETS,
  BROWSER_DUAL_SESSION_BUDGETS,
  checkBrowserBenchBudgets,
  BROWSER_STRESS_BUDGETS,
  checkBrowserStressBudgets,
  checkBrowserDualSessionBudgets,
  runBrowserDualSessionSwitchBench,
  runBrowserRouteSwitchBench,
  runBrowserStreamBench,
  type BrowserBenchResult,
  type DualSessionSwitchBenchResult,
} from './browser-perf-probe.js'

export type EvopanelPerfHook = {
  enabled(): boolean
  budgets: typeof CLIENT_PERF_BUDGETS
  browserBudgets: typeof BROWSER_PERF_BUDGETS
  dualSessionBudgets: typeof BROWSER_DUAL_SESSION_BUDGETS
  stressBudgets: typeof BROWSER_STRESS_BUDGETS
  stats(): ClientPerfSnapshot
  reset(): void
  /** Synthetic workload — no backend / SSE required */
  simulateTextStream(deltas?: number, livePath?: boolean): StreamSimResult
  /** Live vs legacy A/B with reduction % */
  compareStreamPaths(deltas?: number): StreamPathCompare
  checkStreamSim(result: StreamSimResult): ReturnType<typeof checkStreamSimBudgets>
  /** Real DOM: flood LiveStream while MessageRow mounted */
  runBrowserBench(opts?: Parameters<typeof runBrowserStreamBench>[0]): Promise<BrowserBenchResult>
  checkBrowserBench(result: BrowserBenchResult): ReturnType<typeof checkBrowserBenchBudgets>
  checkBrowserStress(result: BrowserBenchResult): ReturnType<typeof checkBrowserStressBudgets>
  runRouteSwitchBench(opts?: Parameters<typeof runBrowserRouteSwitchBench>[0]): Promise<
    BrowserBenchResult & { route: string }
  >
  runDualSessionSwitchBench(
    opts?: Parameters<typeof runBrowserDualSessionSwitchBench>[0],
  ): Promise<DualSessionSwitchBenchResult>
  checkDualSessionBench(
    result: DualSessionSwitchBenchResult,
  ): ReturnType<typeof checkBrowserDualSessionBudgets>
  probeInput(): Promise<number>
  printReport(): void
  hideHud(): void
  showHud(): void
}

declare global {
  interface Window {
    __evopanelPerf?: EvopanelPerfHook
  }
}

let overlayEl: HTMLDivElement | null = null
let overlayTimer: ReturnType<typeof setInterval> | null = null

function formatStats(s: ClientPerfSnapshot): string {
  const t = s.lastTurnSummary
  const turnLine = t
    ? `turn ${Math.round(t.turnMs)}ms · tick ${t.displayTickBumps} · live ${t.liveStreamPublishes} · δ ${t.sseTextDeltas}`
    : 'turn —'
  return [
    `chat ${s.chatSurfaceVisible ? 'visible' : 'hidden'}`,
    turnLine,
    `tick ${s.displayTickBumps} · live ${s.liveStreamPublishes} · raf ${s.liveStreamRafFlushes}`,
    `sse text ${s.sseTextDeltas} · struct ${s.sseStructuralEvents}`,
  ].join('\n')
}

function removeOverlay(): void {
  if (overlayTimer) clearInterval(overlayTimer)
  overlayTimer = null
  overlayEl?.remove()
  overlayEl = null
}

function ensureOverlay(): void {
  if (!isClientPerfHudEnabled() || overlayEl) return
  overlayEl = document.createElement('div')
  overlayEl.id = 'evopanel-perf-hud'
  overlayEl.style.cssText =
    'position:fixed;bottom:8px;right:8px;z-index:99999;font:11px/1.35 ui-monospace,monospace;' +
    'background:rgba(0,0,0,.78);color:#9f9;padding:8px 28px 8px 10px;border-radius:6px;' +
    'white-space:pre;max-width:min(360px,90vw)'
  const statsEl = document.createElement('span')
  statsEl.textContent = formatStats(getClientPerfSnapshot())
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.setAttribute('aria-label', '关闭性能监控')
  closeBtn.textContent = '×'
  closeBtn.title = '关闭性能监控'
  closeBtn.style.cssText =
    'position:absolute;top:2px;right:4px;border:0;background:transparent;color:#9f9;' +
    'font:16px/1 sans-serif;cursor:pointer;padding:2px 6px;opacity:.85'
  closeBtn.addEventListener('click', () => {
    setClientPerfHudEnabled(false)
    removeOverlay()
  })
  overlayEl.append(statsEl, closeBtn)
  document.body.appendChild(overlayEl)
  overlayTimer = setInterval(() => {
    if (!isClientPerfHudEnabled()) {
      removeOverlay()
      return
    }
    statsEl.textContent = formatStats(getClientPerfSnapshot())
  }, 1000)
}

export function installClientPerfHook(): void {
  if (typeof window === 'undefined') return

  const hook: EvopanelPerfHook = {
    enabled: isClientPerfEnabled,
    budgets: CLIENT_PERF_BUDGETS,
    browserBudgets: BROWSER_PERF_BUDGETS,
    dualSessionBudgets: BROWSER_DUAL_SESSION_BUDGETS,
    stressBudgets: BROWSER_STRESS_BUDGETS,
    stats: getClientPerfSnapshot,
    reset: resetClientPerf,
    simulateTextStream: (deltas = 500, livePath) =>
      simulateTextOnlyStream(deltas, livePath === undefined ? undefined : { livePath }),
    compareStreamPaths,
    checkStreamSim: checkStreamSimBudgets,
    runBrowserBench: runBrowserStreamBench,
    checkBrowserBench: checkBrowserBenchBudgets,
    checkBrowserStress: checkBrowserStressBudgets,
    runRouteSwitchBench: runBrowserRouteSwitchBench,
    runDualSessionSwitchBench: runBrowserDualSessionSwitchBench,
    checkDualSessionBench: checkBrowserDualSessionBudgets,
    probeInput: probeInputLatency,
    printReport() {
      const cmp = compareStreamPaths(500)
      const check = checkStreamSimBudgets(cmp.live)
      // eslint-disable-next-line no-console
      console.log('[evopanel perf]', {
        enabled: isClientPerfEnabled(),
        stats: getClientPerfSnapshot(),
        compare: cmp,
        liveBudgetOk: check.ok,
        failures: check.failures,
      })
    },
    hideHud() {
      setClientPerfHudEnabled(false)
      removeOverlay()
    },
    showHud() {
      setClientPerfHudEnabled(true)
      ensureOverlay()
    },
  }

  window.__evopanelPerf = hook

  if (isClientPerfHudEnabled()) {
    ensureOverlay()
    // eslint-disable-next-line no-console
    console.info(
      '[evopanel perf] HUD on · __evopanelPerf.compareStreamPaths() · __evopanelPerf.printReport()',
    )
  }
}

export function disposeClientPerfHook(): void {
  removeOverlay()
}
