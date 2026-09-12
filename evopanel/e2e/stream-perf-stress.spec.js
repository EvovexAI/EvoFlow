// @ts-check
/**
 * Stress perf bench — 2k–10k deltas at realistic 80/s SSE rate; 100–1000 history rows.
 * Full suite can take ~6–8 min (10k@80/s alone ≈ 125s).
 */
import { test, expect } from '@playwright/test'
import { installMinimalShellStubs, openBenchStreamPerf, openBenchDualSessionPerf, formatBrowserBench } from './helpers.js'

const SSE_RATE = 80

/** Core ladder: flood + rate-limited long streams + long history. */
const STRESS = [
  { label: '2k max flood', deltas: 2000, history: 0, stress: true, rate: 0 },
  { label: '5k @80/s', deltas: 5000, history: 0, stress: true, rate: SSE_RATE },
  { label: '10k @80/s', deltas: 10_000, history: 0, stress: true, rate: SSE_RATE },
  { label: '2k @80/s + 500 history', deltas: 2000, history: 500, stress: true, rate: SSE_RATE },
  { label: '2k @80/s + 1000 history', deltas: 2000, history: 1000, stress: true, rate: SSE_RATE },
]

test.describe('stream perf stress (browser DOM)', () => {
  test.describe.configure({ timeout: 600_000 })

  test.beforeEach(async ({ page }) => {
    await installMinimalShellStubs(page)
    await page.addInitScript(() => {
      try {
        localStorage.setItem('evopanel_client_perf', '1')
        localStorage.setItem('evopanel_live_stream_path', '1')
      } catch {
        /* ignore */
      }
    })
  })

  for (const spec of STRESS) {
    test(`stress: ${spec.label}`, async ({ page }) => {
      const historyQuery = spec.history > 0 ? `&history=${spec.history}` : ''
      await openBenchStreamPerf(page, { historyQuery })

      if (spec.history > 0) {
        await page.waitForFunction(
          (n) =>
            Number(document.querySelector('[data-bench-history]')?.getAttribute('data-bench-history')) >=
            n,
          spec.history,
          { timeout: 120_000 },
        )
      }

      const result = await page.evaluate(
        async ({ deltas, stress, rate }) => {
          const bench = await window.__evopanelPerf.runBrowserBench({
            deltaCount: deltas,
            probeInputDuring: true,
            livePath: true,
            stress,
            chunksPerSec: rate > 0 ? rate : undefined,
            // Product tail window (MarkdownHtml + overlay) bounds DOM; do not
            // fake-truncate in the probe — that hid the real paint cost.
          })
          const check = window.__evopanelPerf.checkBrowserStress(bench)
          return { bench, check }
        },
        { deltas: spec.deltas, stress: spec.stress, rate: spec.rate },
      )

      // eslint-disable-next-line no-console
      console.log(formatBrowserBench(`STRESS ${spec.label}`, result.bench, result.check))

      expect(result.bench.displayTickBumps).toBe(0)
      expect(result.bench.publishAttempts).toBe(spec.deltas)
      expect(result.bench.liveStreamPublishes).toBe(spec.deltas)
      expect(result.bench.longTaskMaxMs).toBeLessThanOrEqual(2000)
      if (spec.rate > 0) {
        expect(result.check.ok, result.check.failures.join('; ')).toBe(true)
      }
    })
  }

  test('stress: 10k max flood (report-only — displayTick must stay 0)', async ({ page }) => {
    await openBenchStreamPerf(page)
    const result = await page.evaluate(async () => {
      const bench = await window.__evopanelPerf.runBrowserBench({
        deltaCount: 10_000,
        probeInputDuring: true,
        livePath: true,
        stress: true,
      })
      return bench
    })

    // eslint-disable-next-line no-console
    console.log(formatBrowserBench('STRESS 10k max flood (report)', result))

    expect(result.displayTickBumps).toBe(0)
    expect(result.liveStreamPublishes).toBe(10_000)
  })

  test('stress: tasks page 2000 @80/s', async ({ page }) => {
    await page.goto('/#/tasks?perf=1', { waitUntil: 'domcontentloaded' })
    await page
      .waitForFunction(
        () => {
          const splash = document.getElementById('boot-splash')
          return !splash || splash.classList.contains('boot-splash--hide')
        },
        { timeout: 90_000 },
      )
      .catch(() => {})
    await page.waitForFunction(() => typeof window.__evopanelPerf?.runBrowserBench === 'function')

    const result = await page.evaluate(async () => {
      const bench = await window.__evopanelPerf.runBrowserBench({
        deltaCount: 2000,
        probeInputDuring: true,
        livePath: true,
        stress: true,
        chunksPerSec: 80,
      })
      const check = window.__evopanelPerf.checkBrowserStress(bench)
      return { bench, check }
    })

    // eslint-disable-next-line no-console
    console.log(formatBrowserBench('STRESS tasks 2k@80/s', result.bench, result.check))

    expect(result.check.ok, result.check.failures.join('; ')).toBe(true)
    expect(result.bench.displayTickBumps).toBe(0)
  })

  test('stress: dual-session 24 switches while both flood @48/burst', async ({ page }) => {
    await openBenchDualSessionPerf(page)
    await page.waitForFunction(() => typeof window.__evopanelPerf?.runDualSessionSwitchBench === 'function')

    const result = await page.evaluate(async () => {
      const bench = await window.__evopanelPerf.runDualSessionSwitchBench({
        switchCount: 24,
        deltasPerBurst: 48,
        probeInputDuring: true,
      })
      const check = window.__evopanelPerf.checkDualSessionBench(bench)
      return { bench, check }
    })

    // eslint-disable-next-line no-console
    console.log(formatBrowserBench('STRESS dual-session switch', result.bench, result.check))

    expect(result.check.ok, result.check.failures.join('; ')).toBe(true)
    expect(result.bench.displayTickBumps).toBe(0)
    expect(result.bench.switchCount).toBe(24)
  })
})
