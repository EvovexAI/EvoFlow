/**
 * E2E: leave #/chat → other menu → return must keep host painted.
 * Also checks deferred pending-session contract used when clicking a conversation off-route.
 */
import { test, expect } from '@playwright/test'
import { installMinimalShellStubs } from './helpers.js'

async function dismissBoot(page) {
  await page
    .waitForFunction(
      () => {
        const splash = document.getElementById('boot-splash')
        return !splash || splash.classList.contains('boot-splash--hide') || !document.body.contains(splash)
      },
      { timeout: 90_000 },
    )
    .catch(() => {})
}

async function hostState(page) {
  return page.evaluate(() => {
    const host = document.getElementById('chat-persistent-host')
    const content = document.getElementById('content')
    const full = document.querySelector('.chat-react-full')
    return {
      hash: location.hash,
      hostHidden: !!host?.hidden,
      hostDisplay: host ? getComputedStyle(host).display : null,
      hostHeight: host?.clientHeight || 0,
      contentHidden: !!content?.hidden,
      contentDisplay: content ? getComputedStyle(content).display : null,
      fullHeight: full?.clientHeight || 0,
      fullExists: !!full,
      pending: sessionStorage.getItem('evopanel_pending_shell_session'),
      hibernate: !!document.querySelector('[data-chat-hibernate="1"]'),
    }
  })
}

test('leave chat to knowledge then return — host visible with ChatApp painted', async ({ page }) => {
  await installMinimalShellStubs(page)
  await page.route('**/api/settings/panel**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ settings: {} }),
    })
  })
  await page.route('**/api/chat/sessions**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sessions: [] }),
    })
  })

  await page.goto('/#/chat', { waitUntil: 'domcontentloaded' })
  await dismissBoot(page)
  await page.waitForSelector('#chat-persistent-host .chat-react-full', { timeout: 90_000 })

  await page.waitForFunction(() => {
    const host = document.getElementById('chat-persistent-host')
    return host && !host.hidden && getComputedStyle(host).display !== 'none' && host.clientHeight > 40
  })

  const before = await hostState(page)
  expect(before.hostHidden, JSON.stringify(before)).toBe(false)
  expect(before.hostDisplay, JSON.stringify(before)).not.toBe('none')
  expect(before.hostHeight, JSON.stringify(before)).toBeGreaterThan(40)

  await page.evaluate(() => {
    location.hash = '/knowledge'
  })
  await page.waitForFunction(() => location.hash.includes('/knowledge'))
  await page.waitForFunction(() => {
    const host = document.getElementById('chat-persistent-host')
    return host && (host.hidden || getComputedStyle(host).display === 'none')
  })

  const mid = await hostState(page)
  expect(mid.fullExists, `must keep ChatApp mounted: ${JSON.stringify(mid)}`).toBe(true)
  expect(mid.hostDisplay === 'none' || mid.hostHidden, JSON.stringify(mid)).toBe(true)

  // Off-route "click conversation": only stash pending + navigate (deferred select)
  await page.evaluate(() => {
    sessionStorage.setItem('evopanel_pending_shell_session', 'agent:main:e2e-deferred')
    location.hash = '/chat'
  })
  await page.waitForFunction(() => location.hash.includes('/chat'))

  try {
    await page.waitForFunction(() => {
      const host = document.getElementById('chat-persistent-host')
      if (!host || host.hidden) return false
      if (getComputedStyle(host).display === 'none') return false
      if ((host.clientHeight || 0) < 40) return false
      const full = document.querySelector('.chat-react-full')
      return !!(full && full.clientHeight > 40) && !document.querySelector('[data-chat-hibernate="1"]')
    }, { timeout: 15_000 })
  } catch (e) {
    throw new Error(`BLANK HOST AFTER RETURN:\n${JSON.stringify(await hostState(page), null, 2)}\n${e}`)
  }

  const after = await hostState(page)
  expect(after.hostHidden, JSON.stringify(after)).toBe(false)
  expect(after.hostDisplay, JSON.stringify(after)).not.toBe('none')
  expect(after.hostHeight, JSON.stringify(after)).toBeGreaterThan(40)
  expect(after.fullHeight, JSON.stringify(after)).toBeGreaterThan(40)
  expect(after.hibernate, JSON.stringify(after)).toBe(false)
  // pending should be consumed by chat-route-shown
  expect(after.pending, JSON.stringify(after)).toBeNull()

  // Must not leave message list permanently hidden via --booting (DOM present but white)
  await page.waitForFunction(() => {
    const scroller = document.querySelector('.react-vlist-scroller')
    if (!scroller) return true // empty home / no list yet is OK
    return !scroller.classList.contains('react-vlist-scroller--booting')
  }, { timeout: 5_000 })
})
