import { apiUrlAsync } from './api-client.js'
import { blog } from './browser-unified-log.js'

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

/** Shared HWND already created (agent CDP path) — panel should place-only. */
export async function browserEmbedExists(threadId: string): Promise<boolean> {
  const tid = String(threadId || '').trim()
  if (!isDesktopTauri() || !tid) return false
  try {
    return await invokeTauri<boolean>('browser_embed_exists', { threadId: tid })
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
  /** 页面 innerWidth/innerHeight。有值时 Rust 按客户区/视口把 CSS 像素换成物理像素。 */
  viewportWidth?: number
  viewportHeight?: number
  /** 早处理器/引擎兜底的估算边界调用必须置 true：面板接管后估算值不得移动窗口。 */
  respectManagedBounds?: boolean
  /** 切签：用 location.replace，避免多标签共用 HWND 时污染后退栈。 */
  replaceUrl?: boolean
}): Promise<BrowserEmbedInfo | null> {
  if (!isDesktopTauri()) return null
  blog(
    'info',
    `[client] upsert tid=${opts.threadId} bounds=(${opts.x},${opts.y} ${opts.width}x${opts.height}) url=${opts.url || 'about:blank'}${opts.respectManagedBounds ? ' managed-only' : ''}${opts.replaceUrl ? ' replace' : ''}`,
  )
  try {
    const url = String(opts.url || '').trim()
    return await invokeTauri<BrowserEmbedInfo>('browser_embed_upsert', {
      threadId: opts.threadId,
      // 有地址才传：恢复显示时不带 url，避免把现有页导航成 about:blank。
      // 新建窗口时 Rust 侧对 None 仍落到 about:blank。
      url: url || null,
      x: opts.x,
      y: opts.y,
      width: opts.width,
      height: opts.height,
      viewportWidth: opts.viewportWidth ?? null,
      viewportHeight: opts.viewportHeight ?? null,
      managedOnly: opts.respectManagedBounds === true ? true : null,
      replaceUrl: opts.replaceUrl === true ? true : null,
    })
  } catch (err) {
    console.warn('[browser-embed] upsert failed', err)
    blog('warn', `[client] upsert failed tid=${opts.threadId} err=${err}`)
    return null
  }
}

export async function browserEmbedSetBounds(opts: {
  threadId: string
  x: number
  y: number
  width: number
  height: number
  viewportWidth?: number
  viewportHeight?: number
  /** 当前右栏就是这个浏览器页。false 时 Rust 不会把窗口再显示出来。 */
  present?: boolean
}): Promise<boolean> {
  if (!isDesktopTauri()) return false
  // 贴位很密，默认不打 info，避免拖动时日志拖慢 IPC。
  try {
    return await invokeTauri<boolean>('browser_embed_set_bounds', {
      threadId: opts.threadId,
      x: opts.x,
      y: opts.y,
      width: opts.width,
      height: opts.height,
      viewportWidth: opts.viewportWidth ?? null,
      viewportHeight: opts.viewportHeight ?? null,
      present: opts.present === true,
    })
  } catch (err) {
    console.warn('[browser-embed] setBounds failed', err)
    blog('warn', `[client] setBounds failed tid=${opts.threadId} err=${err}`)
    return false
  }
}

export type BrowserEmbedCoordsProbe = {
  label: string
  kind: string
  visible: boolean
  parked: boolean
  webviewScreen: { x: number; y: number; w: number; h: number }
  webviewClient: { x: number; y: number; w: number; h: number }
  mainClient: { w: number; h: number }
  originScreen: { x: number; y: number }
  lastSlot?: { x: number; y: number; w: number; h: number } | null
}

/** 读原生 WebView 当前矩形，和 HTML 槽位对照用。 */
export async function browserEmbedProbeCoords(
  threadId: string,
): Promise<BrowserEmbedCoordsProbe | null> {
  const tid = String(threadId || '').trim()
  if (!isDesktopTauri() || !tid) return null
  try {
    return await invokeTauri<BrowserEmbedCoordsProbe | null>('browser_embed_probe_coords', {
      threadId: tid,
    })
  } catch (err) {
    console.warn('[browser-embed] probeCoords failed', err)
    return null
  }
}

/** 内嵌页 ZoomFactor（0.5–2.5）。与页面内 Ctrl+滚轮同一套缩放。 */
export async function browserEmbedSetZoom(threadId: string, factor: number): Promise<boolean> {
  const tid = String(threadId || '').trim()
  if (!isDesktopTauri() || !tid) return false
  const scale = Math.min(2.5, Math.max(0.5, Number(factor) || 1))
  try {
    const ok = await invokeTauri<boolean>('browser_embed_set_zoom', {
      threadId: tid,
      factor: scale,
    })
    if (!ok) {
      console.warn('[browser-embed] setZoom returned false', { tid, scale })
      blog('warn', `[client] setZoom missed tid=${tid} factor=${scale}`)
    }
    return ok
  } catch (err) {
    console.warn('[browser-embed] setZoom failed', err)
    blog('warn', `[client] setZoom failed tid=${tid} err=${err}`)
    return false
  }
}

/** 非当前标签：把原生窗口挪出屏幕，不销毁（CDP 仍可用）。 */
export async function browserEmbedPark(threadId: string): Promise<void> {
  const tid = String(threadId || '').trim()
  if (!isDesktopTauri() || !tid) return
  blog('info', `[client] park tid=${tid}`)
  try {
    await invokeTauri('browser_embed_park', { threadId: tid })
  } catch (err) {
    console.warn('[browser-embed] park failed', err)
    blog('warn', `[client] park failed tid=${tid} err=${err}`)
  }
}

export async function browserEmbedClose(threadId: string): Promise<void> {
  if (!isDesktopTauri()) return
  blog('info', `[client] close tid=${threadId}`)
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
    blog('warn', `[client] register cdp failed tid=${tid} err=${err}`)
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
