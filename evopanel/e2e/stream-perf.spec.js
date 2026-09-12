// @ts-check
/**
 * Browser perf bench — real MessageRow + LiveStream in Chromium.
 * No Gateway, no LLM, no manual chat required.
 */
import { test, expect } from '@playwright/test'
import { installMinimalShellStubs, openBenchStreamPerf, openBenchDualSessionPerf, formatBrowserBench } from './helpers.js'

test.describe('stream perf bench (browser DOM)', () => {
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

  test('live stream flood on real MessageRow meets frame budgets', async ({ page }) => {
    await openBenchStreamPerf(page)
    await page.waitForFunction(() => typeof window.__evopanelPerf?.runBrowserBench === 'function')

    const result = await page.evaluate(async () => {
      const bench = await window.__evopanelPerf.runBrowserBench({
        deltaCount: 600,
        probeInputDuring: true,
        livePath: true,
      })
      const check = window.__evopanelPerf.checkBrowserBench(bench)
      return { bench, check }
    })

    // eslint-disable-next-line no-console
    console.log(formatBrowserBench('live DOM flood', result.bench, result.check))

    expect(result.check.ok, result.check.failures.join('; ')).toBe(true)
    expect(result.bench.displayTickBumps).toBe(0)
    expect(result.bench.liveStreamPublishes).toBeGreaterThan(100)
  })

  test('long stream (1500 deltas) stays within relaxed budgets', async ({ page }) => {
    await openBenchStreamPerf(page)
    const result = await page.evaluate(async () => {
      const bench = await window.__evopanelPerf.runBrowserBench({
        deltaCount: 1500,
        probeInputDuring: true,
        livePath: true,
      })
      return bench
    })

    // eslint-disable-next-line no-console
    console.log(formatBrowserBench('long stream', result))

    expect(result.displayTickBumps).toBe(0)
    expect(result.longTasks).toBeLessThanOrEqual(8)
    expect(result.longTaskMaxMs).toBeLessThanOrEqual(800)
    expect(result.frameP95Ms).toBeLessThanOrEqual(150)
  })

  test('background stream while on tasks page (ChatApp still mounted)', async ({ page }) => {
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
        deltaCount: 400,
        probeInputDuring: true,
        livePath: true,
      })
      return bench
    })

    // eslint-disable-next-line no-console
    console.log(formatBrowserBench('tasks-page background flood', result))

    expect(result.liveStreamPublishes).toBeGreaterThan(50)
    expect(result.displayTickBumps).toBe(0)
    expect(result.longTaskMaxMs).toBeLessThanOrEqual(1000)
  })

  test('dual-session switch while both streams flood meets switch INP budget', async ({ page }) => {
    await openBenchDualSessionPerf(page)
    await page.waitForFunction(() => typeof window.__evopanelPerf?.runDualSessionSwitchBench === 'function')

    const result = await page.evaluate(async () => {
      const bench = await window.__evopanelPerf.runDualSessionSwitchBench({
        switchCount: 10,
        deltasPerBurst: 40,
        probeInputDuring: true,
      })
      const check = window.__evopanelPerf.checkDualSessionBench(bench)
      return { bench, check }
    })

    // eslint-disable-next-line no-console
    console.log(formatBrowserBench('dual-session switch', result.bench, result.check))

    expect(result.check.ok, result.check.failures.join('; ')).toBe(true)
    expect(result.bench.displayTickBumps).toBe(0)
    expect(result.bench.switchCount).toBe(10)
    expect(result.bench.switchInputP95Ms).toBeLessThanOrEqual(280)
  })
})
