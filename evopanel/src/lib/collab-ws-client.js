/**
 * WebSocket client for collab workflow state, task progress, and agent stream events.
 * Endpoint: GET upgrade ``/api/events/ws/threads/{threadId}``
 */

/** @typedef {{ type?: string, data?: Record<string, unknown>, timestamp?: string }} CollabWsEvent */

function isDesktopTauri() {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
}

function resolveGatewayHttpBase() {
  if (!isDesktopTauri()) {
    try {
      if (import.meta?.env?.DEV) return ''
    } catch {
      // ignore
    }
  }
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

/**
 * @param {string} threadId
 * @returns {Promise<string>}
 */
export async function collabThreadWsUrl(threadId) {
  const tid = String(threadId || '').trim()
  const path = `/api/events/ws/threads/${encodeURIComponent(tid)}`
  let httpUrl = ''
  try {
    if (import.meta?.DEV) {
      let direct = resolveGatewayHttpBase()
      if (!direct && isDesktopTauri()) {
        try {
          const res = await fetch('/__api/workspace_runtime_info', { credentials: 'same-origin' })
          if (res.ok) {
            const data = await res.json().catch(() => ({}))
            direct = String(data?.runtimeBaseUrl || '').trim().replace(/\/+$/, '')
          }
        } catch {
          // ignore
        }
      }
      if (direct) httpUrl = `${direct}${path}`
    }
  } catch {
    // ignore
  }
  if (!httpUrl) {
    const { apiUrlAsync } = await import('./api-client.js')
    httpUrl = import.meta.env?.DEV ? path : await apiUrlAsync(`/events/ws/threads/${encodeURIComponent(tid)}`)
  }
  if (httpUrl.startsWith('ws://') || httpUrl.startsWith('wss://')) return httpUrl
  const base =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://127.0.0.1'
  const u = new URL(httpUrl, base)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  return u.toString()
}

/**
 * @typedef {Object} SubscribeCollabThreadWsOpts
 * @property {(event: CollabWsEvent) => void} [onEvent]
 * @property {(err: unknown) => void} [onError]
 * @property {() => void} [onOpen]
 * @property {() => void} [onClose]
 * @property {string} [mainTaskId] - optional extra channel subscription after connect
 * @property {boolean} [autoReconnect]
 */

/**
 * Subscribe to collab WebSocket for one LangGraph thread.
 * @param {string} threadId
 * @param {SubscribeCollabThreadWsOpts} [opts]
 * @returns {() => void} unsubscribe
 */
export function subscribeCollabThreadWs(threadId, opts = {}) {
  const tid = String(threadId || '').trim()
  if (!tid) return () => {}

  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null
  const onError = typeof opts.onError === 'function' ? opts.onError : null
  const onOpen = typeof opts.onOpen === 'function' ? opts.onOpen : null
  const onClose = typeof opts.onClose === 'function' ? opts.onClose : null
  const mainTaskId = String(opts.mainTaskId || '').trim()
  const autoReconnect = opts.autoReconnect !== false

  let cancelled = false
  let ws = null
  let reconnectTimer = null
  let backoffMs = 1000

  const cleanupSocket = () => {
    if (reconnectTimer != null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (ws) {
      try {
        ws.onopen = null
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = null
        ws.close()
      } catch {
        /* ignore */
      }
      ws = null
    }
  }

  const scheduleReconnect = () => {
    if (cancelled || !autoReconnect) return
    const delay = backoffMs
    backoffMs = Math.min(backoffMs * 2, 15000)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connect()
    }, delay)
  }

  const connect = async () => {
    if (cancelled) return
    cleanupSocket()
    let url
    try {
      url = await collabThreadWsUrl(tid)
    } catch (e) {
      onError?.(e)
      scheduleReconnect()
      return
    }
    try {
      ws = new WebSocket(url)
    } catch (e) {
      onError?.(e)
      scheduleReconnect()
      return
    }

    ws.onopen = () => {
      backoffMs = 1000
      onOpen?.()
      if (mainTaskId) {
        try {
          ws?.send(JSON.stringify({ type: 'subscribe', main_task_id: mainTaskId }))
        } catch {
          /* ignore */
        }
      }
    }

    ws.onmessage = (ev) => {
      const raw = String(ev?.data || '').trim()
      if (!raw) return
      try {
        const parsed = JSON.parse(raw)
        if (parsed?.type === 'ping') {
          try {
            ws?.send(JSON.stringify({ type: 'pong' }))
          } catch {
            /* ignore */
          }
          return
        }
        onEvent?.(parsed)
      } catch (e) {
        onError?.(e)
      }
    }

    ws.onerror = (e) => {
      onError?.(e)
    }

    ws.onclose = () => {
      onClose?.()
      if (!cancelled) scheduleReconnect()
    }
  }

  void connect()

  return () => {
    cancelled = true
    cleanupSocket()
  }
}
