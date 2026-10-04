// Live browser viewport helper — calls the in-process browser engine via Gateway HTTP.
// Engine exposes viewport resize + viewport-pixel click on top of the existing
// CDP screencast. Both endpoints return synchronously.

import { apiUrlAsync } from './api-client.js'

export type BrowserViewportSize = { width: number; height: number }

export const DEFAULT_BROWSER_VIEWPORT: BrowserViewportSize = { width: 1280, height: 720 }

/** Mobile / tablet presets in CSS px. */
export const BROWSER_VIEWPORT_PRESETS = [
  { id: 'desktop', width: 1280, height: 720, label: '桌面' },
  { id: 'iphone', width: 393, height: 852, label: 'iPhone 16' },
  { id: 'ipad', width: 820, height: 1180, label: 'iPad' },
] as const

export type BrowserViewportPresetId = (typeof BROWSER_VIEWPORT_PRESETS)[number]['id'] | 'custom'

async function postBrowserViewport(threadId: string, size: BrowserViewportSize, reset = false): Promise<boolean> {
  const tid = String(threadId || '').trim()
  if (!tid) return false
  const path = reset
    ? `/api/threads/${encodeURIComponent(tid)}/browser-viewport/reset`
    : `/api/threads/${encodeURIComponent(tid)}/browser-viewport`
  try {
    const url = await apiUrlAsync(path.replace(/^\/api\//, ''))
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(size),
    })
    return res.ok
  } catch {
    return false
  }
}

export type BrowserTabSummary = {
  tabId: string
  url: string
  title: string
  active?: boolean | null
}

export type BrowserTabsResult = { ok: boolean; tabs: BrowserTabSummary[] }

async function postBrowserTabs(
  threadId: string,
  action: 'list' | 'select' | 'new' | 'close',
  payload: Record<string, unknown> = {},
): Promise<BrowserTabsResult | null> {
  const tid = String(threadId || '').trim()
  if (!tid) return null
  const path = `/api/threads/${encodeURIComponent(tid)}/browser-tabs/${action}`
  try {
    const url = await apiUrlAsync(path.replace(/^\/api\//, ''))
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { ok?: boolean; tabs?: BrowserTabSummary[] }
    return {
      ok: data?.ok !== false,
      tabs: Array.isArray(data?.tabs) ? data.tabs : [],
    }
  } catch {
    return null
  }
}

export async function listBrowserTabs(threadId: string): Promise<BrowserTabsResult | null> {
  return postBrowserTabs(threadId, 'list')
}

export async function selectBrowserTab(threadId: string, index: number): Promise<boolean> {
  const tid = String(threadId || '').trim()
  if (!tid) return false
  const path = `/api/threads/${encodeURIComponent(tid)}/browser-tabs/select`
  try {
    const url = await apiUrlAsync(path.replace(/^\/api\//, ''))
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index }),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function newBrowserTab(threadId: string, url = ''): Promise<boolean> {
  const tid = String(threadId || '').trim()
  if (!tid) return false
  const path = `/api/threads/${encodeURIComponent(tid)}/browser-tabs/new`
  try {
    const target = await apiUrlAsync(path.replace(/^\/api\//, ''))
    const res = await fetch(target, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function closeBrowserTab(threadId: string, index: number): Promise<boolean> {
  const tid = String(threadId || '').trim()
  if (!tid) return false
  const path = `/api/threads/${encodeURIComponent(tid)}/browser-tabs/close`
  try {
    const url = await apiUrlAsync(path.replace(/^\/api\//, ''))
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index }),
    })
    return res.ok
  } catch {
    return false
  }
}

export type BrowserNavMethod = 'navigate' | 'back' | 'forward'

export async function sendBrowserCommand(
  threadId: string,
  method: BrowserNavMethod,
  url = '',
): Promise<boolean> {
  const tid = String(threadId || '').trim()
  if (!tid) return false
  const path = `/api/threads/${encodeURIComponent(tid)}/browser-command`
  try {
    const url_ = await apiUrlAsync(path.replace(/^\/api\//, ''))
    const res = await fetch(url_, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, url }),
    })
    return res.ok
  } catch {
    return false
  }
}

export type BrowserScrollDelta = { delta_x: number; delta_y: number }

export async function scrollBrowserBy(
  threadId: string,
  deltaX: number,
  deltaY: number,
): Promise<boolean> {
  const tid = String(threadId || '').trim()
  if (!tid) return false
  const path = `/api/threads/${encodeURIComponent(tid)}/browser-scroll`
  try {
    const url = await apiUrlAsync(path.replace(/^\/api\//, ''))
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delta_x: deltaX, delta_y: deltaY }),
    })
    return res.ok
  } catch {
    return false
  }
}

export function setBrowserViewport(threadId: string, size: BrowserViewportSize): Promise<boolean> {
  return postBrowserViewport(threadId, size, false)
}

export function resetBrowserViewport(threadId: string): Promise<boolean> {
  return postBrowserViewport(threadId, DEFAULT_BROWSER_VIEWPORT, true)
}

export type BrowserClickOptions = {
  x: number
  y: number
  button?: 'left' | 'right' | 'middle'
  doubleClick?: boolean
}

export async function clickBrowserAt(
  threadId: string,
  opts: BrowserClickOptions,
): Promise<boolean> {
  const tid = String(threadId || '').trim()
  if (!tid) return false
  const path = `/api/threads/${encodeURIComponent(tid)}/browser-click`
  try {
    const url = await apiUrlAsync(path.replace(/^\/api\//, ''))
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        x: opts.x,
        y: opts.y,
        button: opts.button || 'left',
        double_click: Boolean(opts.doubleClick),
      }),
    })
    return res.ok
  } catch {
    return false
  }
}