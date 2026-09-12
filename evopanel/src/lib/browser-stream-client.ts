import { apiUrlAsync } from './api-client.js'

export type BrowserStreamFrameMetadata = {
  deviceWidth?: number
  deviceHeight?: number
  pageScaleFactor?: number
  offsetTop?: number
  scrollOffsetX?: number
  scrollOffsetY?: number
}

export type BrowserStreamCallbacks = {
  onFrame?: (dataUrl: string, metadata?: BrowserStreamFrameMetadata) => void
  onStatus?: (status: 'connecting' | 'live' | 'reconnecting' | 'error' | 'closed') => void
  onError?: (message: string) => void
}

const MAX_BOOT_ATTEMPTS = 10
const MAX_LIVE_RECONNECTS = 40
const RETRY_BASE_MS = 1200

function isDesktopTauri() {
  return typeof window !== 'undefined' && !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
}

function resolveGatewayHttpBase() {
  try {
    const env = (import.meta && import.meta.env) || {}
    const url = String(env.VITE_EVOFLOW_GATEWAY_URL || env.EVOFLOW_GATEWAY_URL || '').trim()
    if (url) return url.replace(/\/+$/, '')
    const port = parseInt(String(env.VITE_EVOFLOW_GATEWAY_PORT || env.EVOFLOW_GATEWAY_PORT || '').trim(), 10)
    if (Number.isFinite(port) && port > 0 && port < 65536) return `http://127.0.0.1:${port}`
  } catch {
    // ignore
  }
  return ''
}

/** Match backend `_safe_thread_segment`. */
export function sanitizeBrowserThreadSegment(threadId: string): string {
  const tid = String(threadId || '').trim() || 'default'
  const safe = tid.replace(/[^\w.-]+/g, '_').slice(0, 120)
  return safe || 'default'
}

export function buildBrowserStreamPath(threadId: string): string {
  const tid = sanitizeBrowserThreadSegment(threadId)
  return `/api/threads/${encodeURIComponent(tid)}/browser-stream`
}

export function buildBrowserStreamRestartPath(threadId: string): string {
  return `${buildBrowserStreamPath(threadId)}/restart`
}

/** Ask Gateway to restart agent-browser screencast (best-effort). */
export async function restartBrowserStream(threadId: string): Promise<boolean> {
  const tid = String(threadId || '').trim()
  if (!tid) return false
  const httpUrl = await resolveGatewayHttpUrl(buildBrowserStreamRestartPath(tid))
  if (!httpUrl) return false
  try {
    const res = await fetch(httpUrl, { method: 'POST', credentials: 'include' })
    return res.ok
  } catch {
    return false
  }
}

async function resolveGatewayHttpUrl(path: string): Promise<string> {
  const raw = String(path || '').trim()
  if (!raw) return ''
  const apiPath = raw.startsWith('/api/') ? raw : raw.startsWith('/') ? `/api${raw}` : `/api/${raw.replace(/^\/+/, '')}`

  let direct = resolveGatewayHttpBase()
  if (!direct && isDesktopTauri()) {
    try {
      const res = await fetch('/__api/workspace_runtime_info', { credentials: 'same-origin' })
      if (res.ok) {
        const data = await res.json().catch(() => ({}))
        direct = String((data as { runtimeBaseUrl?: string })?.runtimeBaseUrl || '')
          .trim()
          .replace(/\/+$/, '')
      }
    } catch {
      // ignore
    }
  }
  if (direct) return `${direct}${apiPath}`

  try {
    if (import.meta?.env?.DEV) return apiPath
  } catch {
    // ignore
  }
  const stripped = apiPath.startsWith('/api/') ? apiPath.slice(4) : apiPath
  return apiUrlAsync(stripped)
}

export async function browserStreamWsUrl(streamPath: string): Promise<string> {
  const raw = String(streamPath || '').trim()
  if (!raw) return ''
  if (raw.startsWith('ws://') || raw.startsWith('wss://')) return raw

  const httpUrl = await resolveGatewayHttpUrl(raw)
  if (!httpUrl) return ''
  if (httpUrl.startsWith('ws://') || httpUrl.startsWith('wss://')) return httpUrl
  const base =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://127.0.0.1'
  const u = new URL(httpUrl, base)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  return u.toString()
}

function frameDataUrl(data: string, format?: string): string {
  const raw = String(data || '').trim()
  if (!raw) return ''
  if (raw.startsWith('data:image/')) return raw
  const mime = String(format || 'jpeg').toLowerCase() === 'png' ? 'image/png' : 'image/jpeg'
  return `data:${mime};base64,${raw}`
}

function readFrameMetadata(data: Record<string, unknown>): BrowserStreamFrameMetadata | undefined {
  const nested = data.metadata
  const source =
    nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : data
  const readNum = (key: string) => {
    const raw = source[key]
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
  }
  const meta: BrowserStreamFrameMetadata = {
    deviceWidth: readNum('deviceWidth'),
    deviceHeight: readNum('deviceHeight'),
    pageScaleFactor: readNum('pageScaleFactor'),
    offsetTop: readNum('offsetTop'),
    scrollOffsetX: readNum('scrollOffsetX'),
    scrollOffsetY: readNum('scrollOffsetY'),
  }
  return meta.deviceWidth || meta.deviceHeight ? meta : undefined
}

/** Persistent WebSocket live stream — reconnects on drop, no HTTP polling. */
export function connectBrowserStream(streamPath: string, callbacks: BrowserStreamCallbacks = {}) {
  let ws: WebSocket | null = null
  let cancelled = false
  let receivedFrame = false
  let bootAttempt = 0
  let liveReconnect = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const cleanup = () => {
    cancelled = true
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    if (ws) {
      try {
        ws.close()
      } catch {
        // ignore
      }
      ws = null
    }
  }

  const scheduleReconnect = (delayMs: number) => {
    if (cancelled) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      void connect()
    }, delayMs)
  }

  const handleMessage = (raw: string) => {
    if (cancelled) return
    try {
      const data = JSON.parse(raw) as Record<string, unknown>
      const type = String(data?.type || '').toLowerCase()
      if (type === 'error') {
        if (!receivedFrame && bootAttempt < MAX_BOOT_ATTEMPTS) {
          scheduleReconnect(RETRY_BASE_MS * Math.min(bootAttempt, 5))
          return
        }
        if (receivedFrame) {
          callbacks.onStatus?.('reconnecting')
          scheduleReconnect(RETRY_BASE_MS * 2)
          return
        }
        callbacks.onError?.(String(data?.message || 'Browser stream error'))
        callbacks.onStatus?.('error')
        return
      }
      if (type === 'status') {
        if (data?.screencasting) callbacks.onStatus?.(receivedFrame ? 'live' : 'connecting')
        return
      }
      if (type === 'frame' && typeof data?.data === 'string' && data.data) {
        receivedFrame = true
        liveReconnect = 0
        bootAttempt = 0
        callbacks.onFrame?.(
          frameDataUrl(data.data, typeof data.format === 'string' ? data.format : undefined),
          readFrameMetadata(data),
        )
        callbacks.onStatus?.('live')
      }
    } catch {
      // ignore non-JSON frames
    }
  }

  const connect = async () => {
    if (cancelled) return
    if (receivedFrame) {
      liveReconnect += 1
      if (liveReconnect > MAX_LIVE_RECONNECTS) {
        callbacks.onStatus?.('closed')
        return
      }
      callbacks.onStatus?.('reconnecting')
    } else {
      bootAttempt += 1
      if (bootAttempt > MAX_BOOT_ATTEMPTS) {
        callbacks.onError?.('无法连接浏览器实时画面')
        callbacks.onStatus?.('error')
        return
      }
      callbacks.onStatus?.('connecting')
    }

    if (ws) {
      try {
        ws.close()
      } catch {
        // ignore
      }
      ws = null
    }

    try {
      const url = await browserStreamWsUrl(streamPath)
      if (!url || cancelled) return
      ws = new WebSocket(url)
      ws.onopen = () => {
        if (cancelled) return
        if (!receivedFrame) callbacks.onStatus?.('connecting')
      }
      ws.onmessage = (ev) => {
        void (async () => {
          if (typeof ev.data === 'string') {
            handleMessage(ev.data)
            return
          }
          if (ev.data instanceof Blob) {
            handleMessage(await ev.data.text())
          }
        })()
      }
      ws.onerror = () => {
        if (cancelled) return
        if (receivedFrame) {
          callbacks.onStatus?.('reconnecting')
          scheduleReconnect(RETRY_BASE_MS * 2)
          return
        }
        if (bootAttempt < MAX_BOOT_ATTEMPTS) {
          scheduleReconnect(RETRY_BASE_MS * Math.min(bootAttempt, 5))
        }
      }
      ws.onclose = () => {
        if (cancelled) return
        if (receivedFrame) {
          callbacks.onStatus?.('reconnecting')
          scheduleReconnect(RETRY_BASE_MS * 2)
          return
        }
        if (bootAttempt < MAX_BOOT_ATTEMPTS) {
          scheduleReconnect(RETRY_BASE_MS * Math.min(bootAttempt, 5))
          return
        }
        callbacks.onError?.('无法连接浏览器实时画面')
        callbacks.onStatus?.('error')
      }
    } catch (err) {
      if (!cancelled && !receivedFrame && bootAttempt < MAX_BOOT_ATTEMPTS) {
        scheduleReconnect(RETRY_BASE_MS * Math.min(bootAttempt, 5))
        return
      }
      callbacks.onError?.(err instanceof Error ? err.message : 'Browser stream connect failed')
      callbacks.onStatus?.('error')
    }
  }

  void connect()
  return cleanup
}
