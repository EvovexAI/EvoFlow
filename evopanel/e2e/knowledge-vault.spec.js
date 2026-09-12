/**
 * Browser E2E: Obsidian Knowledge Vault navigation + empty state + wizard.
 *
 * Auth: browser WebUI may force login. When EVOFLOW_E2E_PASSWORD is unset we
 * stub GET /api/webui/status → { enabled: false } so the shell can load.
 * Vault list can be stubbed with EVOFLOW_E2E_MOCK_VAULTS=1 (default when no password).
 */
import { test, expect } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SHOT_DIR = path.join(__dirname, 'artifacts', 'knowledge-vault')

async function installApiStubs(page) {
  const usePassword = !!(process.env.EVOFLOW_E2E_PASSWORD || '').trim()
  const mockVaults = process.env.EVOFLOW_E2E_MOCK_VAULTS === '1' || !usePassword

  await page.route('**/api/webui/status', async (route) => {
    if (usePassword) return route.continue()
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

  if (mockVaults) {
    await page.route('**/api/knowledge/vaults', async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      })
    })
  }

  // Health so browser boot does not stick on backend-down
  await page.route('**/api/**/health**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
  }).catch(() => {})
  await page.route('**/api/observability/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    })
  })
}

async function dismissOverlays(page) {
  await page
    .waitForFunction(
      () => {
        const splash = document.getElementById('boot-splash')
        return !splash || splash.classList.contains('boot-splash--hide') || !document.body.contains(splash)
      },
      { timeout: 90_000 },
    )
    .catch(() => {})

  // Legacy overlay login
  const loginOverlay = page.locator('#login-overlay')
  if (await loginOverlay.isVisible({ timeout: 800 }).catch(() => false)) {
    const pw = process.env.EVOFLOW_E2E_PASSWORD || ''
    if (pw) {
      await page.locator('#login-pw').fill(pw)
      await page.locator('#login-form button[type="submit"]').click()
      await loginOverlay.waitFor({ state: 'hidden', timeout: 15_000 })
    }
  }

  // WebUI remote login page (#/login)
  if ((page.url() || '').includes('#/login') || (await page.locator('#login-password').isVisible().catch(() => false))) {
    const pw = (process.env.EVOFLOW_E2E_PASSWORD || '').trim()
    if (!pw) {
      throw new Error(
        'Stuck on WebUI login. Set EVOFLOW_E2E_PASSWORD or rely on webui/status stub (enabled:false).',
      )
    }
    await page.locator('#login-username').fill('admin')
    await page.locator('#login-password').fill(pw)
    await page.locator('#login-submit').click()
    await page.waitForFunction(() => !window.location.hash.includes('/login'), { timeout: 20_000 })
  }

  // Uncollapse shell aside (chat page hides global expand when collapsed)
  await page.evaluate(() => {
    const el = document.getElementById('app-shell-aside')
    if (el) el.classList.remove('collapsed')
    const btn = document.getElementById('shell-aside-expand')
    if (btn) {
      btn.hidden = true
      btn.classList.remove('is-visible')
    }
  })
}

test.describe('Knowledge Vault GUI', () => {
  test.beforeAll(() => {
    fs.mkdirSync(SHOT_DIR, { recursive: true })
  })

  test('nav entry → empty state → wizard → hash reload', async ({ page }) => {
    const consoleErrors = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await installApiStubs(page)
    await page.goto('/#/chat', { waitUntil: 'domcontentloaded' })
    await dismissOverlays(page)

    // Wait for shell nav to mount
    await page.waitForSelector('#app-shell-aside [data-shell-nav]', { timeout: 60_000 })

    const nav = page.locator('[data-testid="nav-knowledge-vaults"]')
    await expect(nav).toBeVisible({ timeout: 30_000 })
    await page.screenshot({ path: path.join(SHOT_DIR, '01-nav-entry.png'), fullPage: true })
    await nav.click()

    await expect(page).toHaveURL(/#\/knowledge\/vaults/)
    await expect(page.locator('[data-testid="kv-page-title"]')).toContainText('知识库', {
      timeout: 30_000,
    })

    const empty = page.locator('[data-testid="kv-empty"]')
    const grid = page.locator('[data-testid="kv-card-grid"]')
    const err = page.locator('[data-testid="kv-error"]')
    await expect(empty.or(grid).or(err)).toBeVisible({ timeout: 30_000 })

    if (await empty.isVisible().catch(() => false)) {
      await expect(empty).toContainText('尚未连接知识库')
      await page.screenshot({ path: path.join(SHOT_DIR, '02-empty-state.png'), fullPage: true })
      await page.locator('[data-testid="kv-empty-add"]').click()
    } else if (await grid.isVisible().catch(() => false)) {
      await page.screenshot({ path: path.join(SHOT_DIR, '02-vault-list.png'), fullPage: true })
      await page.locator('[data-testid="kv-add-vault"]').click()
    } else {
      await page.screenshot({ path: path.join(SHOT_DIR, '02-api-error.png'), fullPage: true })
      await page.locator('[data-testid="kv-add-vault"]').click()
    }

    const wizard = page.locator('[data-testid="kv-wizard"]')
    await expect(wizard).toBeVisible()
    await expect(wizard).toContainText('选择文件夹')
    await page.screenshot({ path: path.join(SHOT_DIR, '03-add-wizard.png'), fullPage: true })

    // Close wizard and verify direct hash navigation
    await page.locator('#wiz-cancel').click()
    await page.goto('/#/knowledge/vaults', { waitUntil: 'domcontentloaded' })
    await dismissOverlays(page)
    await expect(page.locator('[data-testid="kv-page-title"]')).toContainText('知识库')
    await page.screenshot({ path: path.join(SHOT_DIR, '04-hash-reload.png'), fullPage: true })

    // Soft-check: ignore network/gateway noise
    const fatal = consoleErrors.filter(
      (t) =>
        !/Failed to fetch|Gateway|8070|net::ERR|WebSocket|favicon|AbortError|proxy/i.test(t),
    )
    expect(fatal, `Unexpected console errors:\n${fatal.join('\n')}`).toEqual([])
  })

  test('mocked search preview and graph regions render', async ({ page }) => {
    await installApiStubs(page)
    await page.route('**/api/knowledge/vaults', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            items: [
              {
                id: 'demo',
                name: 'Demo Vault',
                vaultPath: 'D:/demo-vault',
                accessMode: 'read_only',
                enabled: true,
              },
            ],
          }),
        })
        return
      }
      return route.continue()
    })
    await page.route('**/api/knowledge/vaults/demo/notes**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          total: 1,
          count: 1,
          items: [{ path: 'Knowledge/EvoFlow.md', title: 'EvoFlow' }],
        }),
      })
    })
    await page.route('**/api/knowledge/vaults/demo/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          searchReady: true,
          noteCount: 3,
          lastIndexedAt: '2026-07-21T00:00:00Z',
          name: 'Demo Vault',
        }),
      })
    })
    await page.route('**/api/knowledge/vaults/demo/search', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              path: 'Knowledge/EvoFlow.md',
              title: 'EvoFlow',
              score: 0.9,
              snippet: 'EvoFlow 桌面 Agent',
              tags: ['product'],
            },
          ],
        }),
      })
    })
    await page.route('**/api/knowledge/vaults/demo/read', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [{ path: 'Knowledge/EvoFlow.md', title: 'EvoFlow', content: '# EvoFlow\n\n预览正文', tags: ['product'] }],
        }),
      })
    })
    await page.route('**/api/knowledge/vaults/demo/graph', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          centerPath: 'Knowledge/EvoFlow.md',
          depth: 1,
          nodes: [
            { id: 'Knowledge/EvoFlow.md', path: 'Knowledge/EvoFlow.md', title: 'EvoFlow' },
            { id: 'Knowledge/Agent Memory.md', path: 'Knowledge/Agent Memory.md', title: 'Agent Memory' },
          ],
          edges: [{ source: 'Knowledge/EvoFlow.md', target: 'Knowledge/Agent Memory.md', type: 'wikilink' }],
          unresolved: [],
          truncated: false,
        }),
      })
    })

    await page.goto('/#/knowledge/vaults', { waitUntil: 'domcontentloaded' })
    await dismissOverlays(page)

    await expect(page.locator('[data-testid="kv-card-demo"]')).toBeVisible({ timeout: 30_000 })
    await page.screenshot({ path: path.join(SHOT_DIR, '05-vault-list.png'), fullPage: true })

    await page.locator('[data-testid="kv-card-demo"]').click()
    await expect(page.locator('[data-testid="kv-detail-view"]')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-testid="kv-browse-tree"]')).toBeVisible()

    await page.locator('[data-testid="kv-tab-search"]').click()
    await expect(page.locator('[data-testid="kv-search-input"]')).toBeVisible()
    await page.locator('[data-testid="kv-search-input"]').fill('EvoFlow')
    await page.locator('[data-testid="kv-search-btn"]').click()
    await expect(page.locator('[data-testid="kv-result-0"]')).toBeVisible()
    await page.screenshot({ path: path.join(SHOT_DIR, '06-search-results.png'), fullPage: true })

    await page.locator('[data-testid="kv-result-0"]').click()
    await expect(page.locator('[data-testid="kv-preview-title"]')).toContainText('EvoFlow')
    await page.screenshot({ path: path.join(SHOT_DIR, '07-note-preview.png'), fullPage: true })

    await expect(page.locator('[data-testid="kv-graph-title"]')).toHaveCount(0)
    await page.locator('[data-testid="kv-graph-toggle"]').click()
    await expect(page.locator('[data-testid="kv-graph-title"]')).toContainText('链接关系')
    await expect(page.locator('[data-testid="kv-graph-edges"]')).toContainText('引用')
    await page.screenshot({ path: path.join(SHOT_DIR, '08-graph.png'), fullPage: true })
  })
})
