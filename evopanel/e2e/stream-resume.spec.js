// @ts-check
import { test, expect } from '@playwright/test'
import {
  openChatReady,
  sendChatMessage,
  trackStreamResumeRequests,
  ensureSessionSelected,
} from './helpers.js'

test.describe('stream resume (Web + Gateway)', () => {
  test('chat page loads in web mode', async ({ page }) => {
    await openChatReady(page)
    await expect(page.locator('.react-chat-input')).toBeVisible()
    await expect(page.locator('.react-chat-composer')).toBeVisible()
  })

  test('send message and receive assistant reply in web mode', async ({ page }) => {
    await openChatReady(page)
    const prompt = process.env.EVOFLOW_E2E_PROMPT || '请只回复两个字：好的'
    await sendChatMessage(page, prompt)
    await expect(page.locator('.msg-user').last()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.msg-ai .msg-bubble').last()).not.toBeEmpty({ timeout: 120_000 })
  })

  test('reload during generation hits stream-resume or restores transcript', async ({ page }) => {
    const resumeUrls = trackStreamResumeRequests(page)
    await openChatReady(page)

    const prompt =
      process.env.EVOFLOW_E2E_LONG_PROMPT ||
      '请用大约80字介绍一下你自己，不要调用任何工具，直接文字输出。'

    await sendChatMessage(page, prompt)
    await expect(page.locator('.msg-user').last()).toContainText('介绍', { timeout: 20_000 })

    const stopBtn = page.locator('.react-chat-icon-stop-btn')
    await stopBtn.waitFor({ state: 'visible', timeout: 60_000 }).catch(async () => {
      await page.locator('.msg-ai-streaming').waitFor({ state: 'visible', timeout: 30_000 })
    })

    const sessionKey = await page.evaluate(
      () => localStorage.getItem('evopanel-chat-selected-session') || '',
    )
    expect(sessionKey).toBeTruthy()

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.evaluate((sk) => {
      if (sk) localStorage.setItem('evopanel-chat-selected-session', sk)
    }, sessionKey)
    await page.goto('/#/chat', { waitUntil: 'domcontentloaded' })

    await page
      .waitForFunction(
        () => {
          const splash = document.getElementById('boot-splash')
          return !splash || splash.classList.contains('boot-splash--hide')
        },
        { timeout: 60_000 },
      )
      .catch(() => {})

    await page.locator('.react-chat-input').waitFor({ state: 'visible', timeout: 60_000 })
    await ensureSessionSelected(page)

    await expect
      .poll(
        async () => {
          if (resumeUrls.length > 0) return 'resume'
          const users = await page.locator('.msg-user').count()
          if (users > 0) return 'transcript'
          const streaming = await page.locator('.msg-ai-streaming').isVisible().catch(() => false)
          if (streaming) return 'streaming'
          return ''
        },
        { timeout: 120_000, intervals: [500, 1000, 2000] },
      )
      .not.toBe('')

    if (resumeUrls.length > 0) {
      expect(resumeUrls.some((u) => u.includes('stream-resume'))).toBe(true)
    } else {
      await expect(page.locator('.msg-user').first()).toBeVisible()
    }
  })

  test('background session keeps sidebar spinner when switching away', async ({ page }) => {
    await openChatReady(page)

    let sessionRows = page.locator('#shell-session-list [data-shell-session]')
    if ((await sessionRows.count()) < 2) {
      await page.locator('#shell-btn-new-task').click()
      await page.waitForTimeout(1200)
      sessionRows = page.locator('#shell-session-list [data-shell-session]')
    }
    test.skip((await sessionRows.count()) < 2, 'need at least two sessions in sidebar')

    const firstKey = await sessionRows.nth(0).getAttribute('data-shell-session')
    const secondKey = await sessionRows.nth(1).getAttribute('data-shell-session')
    expect(firstKey).toBeTruthy()
    expect(secondKey).toBeTruthy()

    await sessionRows.nth(0).click()
    await page.waitForTimeout(400)

    const prompt =
      process.env.EVOFLOW_E2E_LONG_PROMPT ||
      '请用大约120字介绍一下你自己，不要调用任何工具，直接文字输出。'
    await sendChatMessage(page, prompt)
    await expect(page.locator('.msg-user').last()).toContainText('介绍', { timeout: 20_000 })

    const stopBtn = page.locator('.react-chat-icon-stop-btn')
    await stopBtn.waitFor({ state: 'visible', timeout: 60_000 }).catch(async () => {
      await page.locator('.msg-ai-streaming').waitFor({ state: 'visible', timeout: 30_000 })
    })

    await page.locator(`[data-shell-session="${secondKey}"]`).click()
    await page.waitForTimeout(600)

    const runningRow = page.locator(`[data-shell-session="${firstKey}"]`)
    await expect(runningRow.locator('.react-chat-session-spinner')).toBeVisible({ timeout: 15_000 })
  })
})
