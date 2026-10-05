import { apiUrlAsync } from './api-client.js'

export type BrowserEmbedInfo = {
  threadId: string
  webviewLabel: string
  /**
   * Loopback WebSocket endpoint that fronts the panel's in-process CDP channel.
   * The backend's Playwright connects to this exactly as it would to Chrome's
   * own debug port; no TCP debug port is opened on the webview.
   */
  cdpUrl: string
  embed: boolean
}

function isDesktopTauri() {
  return typeof window !== 'undefined' && !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
}

/**
 * Synchronous capability probe.
 *
 * The panel must decide *synchronously* whether to open the screencast socket.
 * Awaiting `invoke('browser_embed_supported')` leaves a window where the answer
 * is still `false`, and during that window the panel connects the screencast —
 * which makes the backend spawn a private Chromium nobody is looking at. The
 * Tauri marker is already on `window`, so answer without a round trip.
 */
export function browserEmbedSupportedSync(): boolean {
  return isDesktopTauri()
}

async function invokeTauri<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

export async function browserEmbedSupported(): Promise<boolean> {
  if (!isDesktopTauri()) return false
  try {
    return await invokeTauri<boolean>('browser_embed_supported')
  } catch {
    return false
  }
}

export async function browserEmbedUpsert(opts: {
  threadId: string
  url?: string
  x: number
  y: number
  width: number
  height: number
}): Promise<BrowserEmbedInfo | null> {
  if (!isDesktopTauri()) return null
  try {
    return await invokeTauri<BrowserEmbedInfo>('browser_embed_upsert', {
      threadId: opts.threadId,
      // Never send `null`: a null here used to come back as "invalid port
      // number" from Tauri's URL handling. The panel legitimately has no page
      // yet on first open, and `about:blank` expresses that without ambiguity.
      url: String(opts.url || '').trim() || 'about:blank',
      x: opts.x,
      y: opts.y,
      width: opts.width,
      height: opts.height,
    })
  } catch (err) {
    console.warn('[browser-embed] upsert failed', err)
    return null
  }
}

export async function browserEmbedSetBounds(opts: {
  threadId: string
  x: number
  y: number
  width: number
  height: number
}): Promise<void> {
  if (!isDesktopTauri()) return
  try {
    await invokeTauri('browser_embed_set_bounds', {
      threadId: opts.threadId,
      x: opts.x,
      y: opts.y,
      width: opts.width,
      height: opts.height,
    })
  } catch {
    // ignore resize races while panel animates
  }
}

export async function browserEmbedClose(threadId: string): Promise<void> {
  if (!isDesktopTauri()) return
  try {
    await invokeTauri('browser_embed_close', { threadId })
  } catch {
    // ignore
  }
}

export async function registerBrowserEmbedCdp(threadId: string, cdpUrl: string): Promise<boolean> {
  const tid = String(threadId || '').trim()
  const url = String(cdpUrl || '').trim()
  if (!tid || !url) return false
  const path = `/api/threads/${encodeURIComponent(tid)}/browser-embed/cdp`
  try {
    const httpUrl = await apiUrlAsync(path.replace(/^\/api\//, ''))
    const res = await fetch(httpUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ cdp_url: url }),
    })
    return res.ok
  } catch (err) {
    console.warn('[browser-embed] register cdp failed', err)
    return false
  }
}

export async function clearBrowserEmbedCdp(threadId: string): Promise<void> {
  const tid = String(threadId || '').trim()
  if (!tid) return
  const path = `/api/threads/${encodeURIComponent(tid)}/browser-embed/cdp`
  try {
    const httpUrl = await apiUrlAsync(path.replace(/^\/api\//, ''))
    await fetch(httpUrl, { method: 'DELETE', credentials: 'include' })
  } catch {
    // ignore
  }
}
