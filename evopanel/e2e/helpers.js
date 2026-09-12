/** @typedef {import('@playwright/test').Page} Page */

/**
 * Stub minimal APIs so shell loads without Gateway password/backend.
 * @param {Page} page
 */
export async function installMinimalShellStubs(page) {
  await page.route('**/api/webui/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        enabled: false,
        running: false,
        admin_username: 'admin',
        password_set: false,
        access_urls: [],
        lan_ip: null,
      }),
    })
  })

  await page.route('**/api/**/health**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
  })

  await page.route('**/api/observability/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    })
  })

  await page.route('**/api/license/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ valid: true, features: [] }),
    })
  }).catch(() => {})
}

/**
 * @param {Page} page
 * @param {{ historyQuery?: string }} [opts]
 */
export async function openBenchStreamPerf(page, opts = {}) {
  const historyQuery = opts.historyQuery || ''
  await page.goto(`/#/bench/stream-perf?perf=1${historyQuery}`, { waitUntil: 'domcontentloaded' })
  await page
    .waitForFunction(
      () => {
        const splash = document.getElementById('boot-splash')
        return !splash || splash.classList.contains('boot-splash--hide')
      },
      { timeout: 90_000 },
    )
    .catch(() => {})
  await page.locator('[data-bench-ready="1"]').waitFor({ state: 'visible', timeout: 90_000 })
  await page.locator('#bench-probe-target').waitFor({ state: 'visible', timeout: 60_000 })
}

export async function openBenchDualSessionPerf(page) {
  await page.goto('/#/bench/dual-session-perf?perf=1', { waitUntil: 'domcontentloaded' })
  await page
    .waitForFunction(
      () => {
        const splash = document.getElementById('boot-splash')
        return !splash || splash.classList.contains('boot-splash--hide')
      },
      { timeout: 90_000 },
    )
    .catch(() => {})
  await page.locator('[data-bench-dual="1"]').waitFor({ state: 'visible', timeout: 90_000 })
  await page.locator('#bench-probe-target').waitFor({ state: 'visible', timeout: 60_000 })
}

/**
 * @param {string} label
 * @param {Record<string, unknown>} bench
 * @param {{ ok?: boolean; failures?: string[] }} [check]
 */
export function formatBrowserBench(label, bench, check) {
  const lines = [
    `[browser] ${label}`,
    `  deltas=${bench.deltaCount} durationMs=${bench.durationMs}`,
    `  longTasks=${bench.longTasks} maxLongTaskMs=${bench.longTaskMaxMs}`,
    `  frameP95Ms=${bench.frameP95Ms} slowFramePct=${bench.slowFramePct}`,
    `  inputP95Ms=${bench.inputLatencyP95Ms ?? '—'}`,
    `  displayTick=${bench.displayTickBumps} livePublish=${bench.liveStreamPublishes}`,
  ]
  if (bench.switchCount != null) lines.push(`  switches=${bench.switchCount}`)
  if (bench.switchInputP95Ms != null) lines.push(`  switchInputP95Ms=${bench.switchInputP95Ms}`)
  if (bench.route) lines.push(`  route=${bench.route}`)
  if (bench.chunksPerSec) lines.push(`  rate=${bench.chunksPerSec}/s`)
  if (bench.deltaCount) {
    const perK = (Number(bench.longTasks) || 0) / Math.max(1, Number(bench.deltaCount) / 1000)
    lines.push(`  longTasksPer1kΔ=${perK.toFixed(1)}`)
  }
  if (check) lines.push(`  budget=${check.ok ? 'PASS' : 'FAIL'} ${(check.failures || []).join('; ')}`)
  return lines.join('\n')
}

/**
 * Open chat in Web mode (#/chat), pass login if required, wait until composer is ready.
 * @param {Page} page
 * @param {{ password?: string }} [opts]
 */
export async function openChatReady(page, opts = {}) {
  await page.goto('/#/chat', { waitUntil: 'domcontentloaded' })

  await page
    .waitForFunction(
      () => {
        const splash = document.getElementById('boot-splash')
        return !splash || splash.classList.contains('boot-splash--hide')
      },
      { timeout: 90_000 },
    )
    .catch(() => {})

  const login = page.locator('#login-overlay')
  if (await login.isVisible({ timeout: 2000 }).catch(() => false)) {
    const pw = opts.password || process.env.EVOFLOW_E2E_PASSWORD || ''
    if (!pw) {
      throw new Error(
        'EvoPanel login required: set EVOFLOW_E2E_PASSWORD or remove accessPassword from ~/.evoflow/evopanel.json',
      )
    }
    await page.locator('#login-pw').fill(pw)
    await page.locator('#login-form button[type="submit"]').click()
    await login.waitFor({ state: 'hidden', timeout: 15_000 })
  }

  const backendDown = page.locator('#backend-down-overlay')
  if (await backendDown.isVisible({ timeout: 2000 }).catch(() => false)) {
    throw new Error('Gateway unreachable from Vite proxy — ensure Gateway is on port 8070')
  }

  const input = page.locator('.react-chat-input')
  await input.waitFor({ state: 'visible', timeout: 90_000 })
  await page.waitForFunction(
    () => {
      const el = document.querySelector('.react-chat-input')
      return el && !el.disabled
    },
    { timeout: 90_000 },
  )
  return input
}

/**
 * @param {Page} page
 * @param {string} text
 */
export async function sendChatMessage(page, text) {
  const input = page.locator('.react-chat-input')
  await input.fill(text)
  await input.press('Enter')
}

/**
 * Re-focus the session that was active before reload (sidebar + localStorage).
 * @param {Page} page
 */
export async function ensureSessionSelected(page) {
  if ((await page.locator('.msg-user').count()) > 0) return

  const sk = await page.evaluate(() => localStorage.getItem('evopanel-chat-selected-session') || '')

  if (sk) {
    const row = page.locator(`[data-shell-session="${sk}"]`)
    if (await row.count()) {
      await row.click()
      await page.waitForTimeout(800)
      if ((await page.locator('.msg-user').count()) > 0) return
    }
    const short = sk.split(':').pop() || ''
    if (short) {
      const escaped = short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const byLabel = page.getByRole('button', { name: new RegExp(escaped) })
      if (await byLabel.count()) {
        await byLabel.first().click()
        await page.waitForTimeout(800)
        if ((await page.locator('.msg-user').count()) > 0) return
      }
    }
  }

  const recent = page.locator('#shell-session-list [data-shell-session]').first()
  if (await recent.count()) {
    await recent.click()
    await page.waitForTimeout(800)
  }
}

/**
 * Wait until transcript has at least one user message (session history loaded).
 * @param {Page} page
 */
export async function waitForTranscript(page) {
  await ensureSessionSelected(page)
  await page.locator('.msg-user').first().waitFor({ state: 'visible', timeout: 90_000 })
}

/**
 * @param {Page} page
 */
export function trackStreamResumeRequests(page) {
  /** @type {string[]} */
  const urls = []
  page.on('request', (req) => {
    const u = req.url()
    if (u.includes('/stream-resume')) urls.push(u)
  })
  return urls
}
