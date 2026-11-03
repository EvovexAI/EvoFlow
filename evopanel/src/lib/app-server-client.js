/**
 * Desktop app-server client: native-style JSON-RPC on the Gateway sidecar stdio
 * (single child process). External Gateway falls back to a mouthpiece child.
 * Web page keeps HTTP/SSE to Gateway.
 */

import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { transportLog } from './transport-log-gate.js'

const APP_SERVER_EVENT = 'evoflow://app-server'

// === DEBUG（默认关）：显式 window.__EVOFLOW_FE_LOG_ENABLED__=true 或 localStorage evoflow-enable-fe-log=1 ===
let _feDebugWrite = null
const _FE_LOG_RING = [] // browser-side ring buffer (max 200 lines), exported via __dumpEvoflowFELog
function _feLogEnabled() {
  try {
    if (typeof window !== 'undefined' && window.__EVOFLOW_FE_LOG_ENABLED__) return true
    if (typeof window !== 'undefined' && window.__EVOFLOW_FE_LOG_DISABLED__) return false
    const ls = window?.localStorage?.getItem?.('evoflow-enable-fe-log')
    return ls === '1' || ls === 'true'
  } catch {
    return false
  }
}
function _feLog(msg) {
  if (!_feLogEnabled()) return
  const line = `[t=${(Date.now()/1000).toFixed(3)}s] ${msg}`
  if (_feDebugWrite) { _feDebugWrite(msg); return }
  _FE_LOG_RING.push(line)
  if (_FE_LOG_RING.length > 200) _FE_LOG_RING.shift()
  try { localStorage.setItem('evoflow-fe-log', _FE_LOG_RING.slice(-200).join('\n')) } catch {}
  try {
    const gw = (typeof window !== 'undefined' && window.__EVOFLOW_GATEWAY_BASE__) || '/__evoflow'
    fetch(`${gw}/__evoflow-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg: line }),
      keepalive: true,
    }).catch(() => {})
  } catch {}
}
// Expose a tiny dumper for browser devtools
if (typeof window !== 'undefined') {
  try { window.__dumpEvoflowFELog = () => (localStorage.getItem('evoflow-fe-log') || '').split('\n') } catch {}
}
const _FE_T0 = Date.now()
function _feTs() { return ((Date.now() - _FE_T0) / 1000).toFixed(3) }

/** @type {Promise<{ ok: boolean, listen_port: number, gateway_base: string, warm?: boolean }> | null} */
let _ensurePromise = null
let _warm = false

/** @type {Map<string, Set<(msg: any) => void>>} */
const _turnListeners = new Map()

/** @type {null | (() => void)} */
let _unlisten = null

function _authToken() {
  try {
    return localStorage.getItem('evoflow_webui_token') || ''
  } catch {
    return ''
  }
}

async function _ensureListener() {
  if (_unlisten) return
  _unlisten = await listen(APP_SERVER_EVENT, (ev) => {
    const payload = ev?.payload
    const message = payload?.message
    if (!message || typeof message !== 'object') return
    const params = message.params || {}
    const turnId = String(params.turnId || params.clientRunId || '')
    if (turnId && _turnListeners.has(turnId)) {
      for (const fn of _turnListeners.get(turnId)) {
        try {
          fn(message)
        } catch {
          /* ignore */
        }
      }
    }
    if (_turnListeners.has('')) {
      for (const fn of _turnListeners.get('')) {
        try {
          fn(message)
        } catch {
          /* ignore */
        }
      }
    }
  })
}

/**
 * @param {string} turnId
 * @param {(msg: any) => void} fn
 * @returns {() => void}
 */
export function onAppServerTurn(turnId, fn) {
  const key = String(turnId || '')
  if (!_turnListeners.has(key)) _turnListeners.set(key, new Set())
  _turnListeners.get(key).add(fn)
  void _ensureListener()
  return () => {
    const set = _turnListeners.get(key)
    if (!set) return
    set.delete(fn)
    if (!set.size) _turnListeners.delete(key)
  }
}

export function isAppServerWarm() {
  return _warm
}

export async function ensureAppServer() {
  if (!_ensurePromise) {
    _ensurePromise = (async () => {
      await _ensureListener()
      const result = await invoke('app_server_ensure')
      _warm = !!(result && (result.warm || result.ok))
      return result
    })().catch((err) => {
      _ensurePromise = null
      _warm = false
      throw err
    })
  }
  return _ensurePromise
}

/** Connect once Gateway is alive (liveness) — do not wait for LangGraph /ready. */
export async function prewarmAppServer() {
  try {
    await ensureAppServer()
    transportLog('app-server prewarm ok', { warm: _warm })
    return true
  } catch (err) {
    _warm = false
    console.warn('[evoflow] app-server prewarm failed (will use Gateway HTTP)', err)
    return false
  }
}

export async function appServerRequest(method, params = {}) {
  await ensureAppServer()
  return invoke('app_server_request', { method, params })
}

export async function appServerNotify(method, params = null) {
  await ensureAppServer()
  return invoke('app_server_notify', { method, params })
}

/**
 * Desktop REST via pipe: resources/call (alias gateway/call) → Gateway HTTP.
 * @returns {Promise<{ ok: boolean, status: number, body: any, error?: any }>}
 */
export async function appServerGatewayCall({ method, path, body = null, query = null, headers = null, timeoutMs = null }) {
  await ensureAppServer()
  const authorization = _authToken() ? `Bearer ${_authToken()}` : ''
  return appServerRequest('resources/call', {
    method: String(method || 'GET').toUpperCase(),
    path,
    body,
    query,
    headers: headers || {},
    authorization,
    ...(timeoutMs ? { timeoutMs } : {}),
  })
}

/**
 * native-style thread/start — create LangGraph thread (+ optional sessionKey metadata).
 * @param {{ sessionKey?: string, threadId?: string, metadata?: Record<string, unknown> }} [opts]
 */
export async function appServerThreadStart(opts = {}) {
  await ensureAppServer()
  const authorization = _authToken() ? `Bearer ${_authToken()}` : ''
  return appServerRequest('thread/start', {
    sessionKey: opts.sessionKey || opts.session_key || '',
    threadId: opts.threadId || opts.thread_id || '',
    metadata: opts.metadata || {},
    authorization,
  })
}

/**
 * native-style thread/resume — bind an existing thread id.
 * @param {{ threadId: string, sessionKey?: string }} opts
 */
export async function appServerThreadResume(opts) {
  await ensureAppServer()
  return appServerRequest('thread/resume', {
    threadId: opts.threadId || opts.thread_id || '',
    sessionKey: opts.sessionKey || opts.session_key || '',
  })
}

/**
 * Start a chat turn via app-server.
 * - With ``onStreamEvent(eventName, data)``: structured path (no SSE text). Returns
 *   ``{ ok, structured: true, done, abort }`` — await ``done`` when the turn finishes.
 * - Without: legacy ReadableStream of SSE text (panel / older callers).
 */
export async function appServerFetchStream(streamPath, options = {}) {
  await ensureAppServer()
  const path = String(streamPath || '')
  const m = path.match(/\/threads\/([^/]+)\/runs\/stream/)
  if (!m) throw new Error('app-server stream path missing thread id')
  const threadId = decodeURIComponent(m[1])

  const qs = path.includes('?') ? path.slice(path.indexOf('?') + 1) : ''
  const query = {}
  new URLSearchParams(qs).forEach((v, k) => {
    if (k === 'stream_mode') {
      if (!Array.isArray(query.stream_mode)) query.stream_mode = []
      query.stream_mode.push(v)
    } else {
      query[k] = v
    }
  })

  let body = {}
  if (typeof options.body === 'string' && options.body) {
    try {
      body = JSON.parse(options.body)
    } catch {
      throw new Error('app-server turn body must be JSON')
    }
  } else if (options.body && typeof options.body === 'object') {
    body = options.body
  }

  const headers = {}
  const rawHeaders = options.headers
  if (rawHeaders instanceof Headers) {
    rawHeaders.forEach((v, k) => {
      headers[k] = v
    })
  } else if (rawHeaders && typeof rawHeaders === 'object') {
    Object.assign(headers, rawHeaders)
  }
  const authorization =
    headers.Authorization || headers.authorization || (_authToken() ? `Bearer ${_authToken()}` : '')

  const turnId = `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const onStreamEvent =
    typeof options.onStreamEvent === 'function' ? options.onStreamEvent : null

  /** @type {{ resolve: (v: any) => void, reject: (e: any) => void } | null} */
  let doneCtl = null
  const done = onStreamEvent
    ? new Promise((resolve, reject) => {
        doneCtl = { resolve, reject }
      })
    : null

  const stream = _openTurnReadableStream(turnId, options.signal, {
    onStreamEvent,
    onTurnCompleted: () => {
      try {
        doneCtl?.resolve({ ok: true })
      } catch {
        /* ignore */
      }
    },
    onTurnError: (err) => {
      try {
        doneCtl?.reject(err instanceof Error ? err : new Error(String(err || 'turn error')))
      } catch {
        /* ignore */
      }
    },
  })

  try {
    await appServerRequest('turn/start', {
      threadId,
      turnId,
      body,
      query,
      authorization,
      headers: {
        'x-evoflow-stream-resume':
          headers['x-evoflow-stream-resume'] || headers['X-Evoflow-Stream-Resume'] || '1',
      },
    })
    transportLog('app-server turn/start accepted', { threadId, turnId, structured: !!onStreamEvent })
  } catch (err) {
    stream.abort()
    try {
      doneCtl?.reject(err)
    } catch {
      /* ignore */
    }
    throw err
  }

  if (onStreamEvent) {
    return {
      ok: true,
      status: 200,
      structured: true,
      body: null,
      done,
      abort: stream.abort,
    }
  }
  return stream.response
}

/**
 * Generic Gateway SSE via pipe (panel-stream, stream-resume, …).
 * @param {string} streamPath e.g. `/api/chat/sessions/x/stream-resume?runId=…`
 * @param {RequestInit} [options]
 */
export async function appServerFetchGatewayStream(streamPath, options = {}) {
  await ensureAppServer()
  const raw = String(streamPath || '')
  const qIdx = raw.indexOf('?')
  const path = qIdx >= 0 ? raw.slice(0, qIdx) : raw
  const search = qIdx >= 0 ? raw.slice(qIdx + 1) : ''
  /** @type {Record<string, string>} */
  const query = {}
  if (search) {
    new URLSearchParams(search).forEach((v, k) => {
      query[k] = v
    })
  }

  let body = null
  if (typeof options.body === 'string' && options.body) {
    try {
      body = JSON.parse(options.body)
    } catch {
      body = null
    }
  } else if (options.body && typeof options.body === 'object') {
    body = options.body
  }

  const headers = {}
  const rawHeaders = options.headers
  if (rawHeaders instanceof Headers) {
    rawHeaders.forEach((v, k) => {
      headers[k] = v
    })
  } else if (rawHeaders && typeof rawHeaders === 'object') {
    Object.assign(headers, rawHeaders)
  }
  const authorization =
    headers.Authorization || headers.authorization || (_authToken() ? `Bearer ${_authToken()}` : '')

  const turnId = `sse-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  // panel-stream / stream-resume / event GET: NOT a turn, do not interrupt on cleanup
  const methodU = String(options.method || 'GET').toUpperCase()
  const noInterrupt = methodU === 'GET'
  _feLog(`FE appServerFetchGatewayStream ENTER path=${path} method=${methodU} turnId=${turnId} noInterrupt=${noInterrupt}`)
  const stream = _openTurnReadableStream(turnId, options.signal, { noInterrupt })

  try {
    await appServerRequest('gateway/stream', {
      method: methodU,
      path,
      body,
      query: Object.keys(query).length ? query : null,
      authorization,
      headers,
      turnId,
    })
    _feLog(`FE appServerRequest RESOLVED turnId=${turnId}`)
    transportLog('app-server gateway/stream accepted', { path, turnId })
  } catch (err) {
    _feLog(`FE appServerRequest REJECTED turnId=${turnId} err=${err && err.message}`)
    stream.abort()
    throw err
  }

  return stream.response
}

/**
 * @param {string} turnId
 * @param {AbortSignal} [signal]
 * @param {{
 *   onStreamEvent?: (eventName: string, data: any) => void,
 *   onTurnCompleted?: () => void,
 *   onTurnError?: (err: Error) => void,
 *   noInterrupt?: boolean,  // true: do NOT send turn/interrupt on cleanup (panel-stream etc.)
 * }} [opts]
 */
function _openTurnReadableStream(turnId, signal, opts = {}) {
  /** @type {ReadableStreamDefaultController<Uint8Array> | null} */
  let controller = null
  const encoder = new TextEncoder()
  let finished = false
  let unsubscribed = false
  const onStreamEvent = typeof opts.onStreamEvent === 'function' ? opts.onStreamEvent : null
  const structured = !!onStreamEvent

  const unsubscribe = onAppServerTurn(turnId, (message) => {
    if (finished) return
    const method = message.method
    const params = message.params || {}
    _feLog(`FE listener RECV turnId=${turnId} method=${method} finished=${finished}`)
    // Structured LangGraph / UI wire events — preferred (no SSE re-wrap).
    if (method === 'stream/event') {
      const ev = String(params.event || 'message')
      const data = params.data
      _feLog(`FE stream/event ev=${ev} dataType=${typeof data} dataPreview=${JSON.stringify(data).slice(0, 80)}`)
      if (onStreamEvent) {
        try {
          onStreamEvent(ev, data)
        } catch (err) {
          console.warn('[evoflow] onStreamEvent failed', ev, err)
        }
        return
      }
      // Legacy: rebuild SSE text for callers that still read resp.body
      if (!controller) return
      try {
        const dataStr =
          typeof data === 'string' ? data : JSON.stringify(data === undefined ? null : data)
        controller.enqueue(encoder.encode(`event: ${ev}\ndata: ${dataStr}\n\n`))
      } catch {
        /* stream closed */
      }
      return
    }
    // Legacy raw SSE chunk shim (older app-server builds).
    if (method === 'stream/sse' && typeof params.chunk === 'string') {
      if (onStreamEvent) {
        try {
          const { eventName, data } = _parseSseChunkToEvent(params.chunk)
          onStreamEvent(eventName || 'message', data)
        } catch {
          /* ignore */
        }
        return
      }
      if (!controller) return
      try {
        controller.enqueue(encoder.encode(params.chunk))
      } catch {
        /* stream closed */
      }
      return
    }
    if (method === 'turn/error') {
      _feLog(`FE turn/error message=${params.message}`)
      finished = true
      const err = new Error(String(params.message || 'app-server turn error'))
      try {
        opts.onTurnError?.(err)
      } catch {
        /* ignore */
      }
      if (!structured && controller) {
        try {
          controller.error(err)
        } catch {
          /* ignore */
        }
      }
      return
    }
    if (method === 'turn/completed' || method === 'turn/result') {
      _feLog(`FE ${method} frames=${params.frames} ok=${params.ok} path=${params.path}`)
      finished = true
      try {
        opts.onTurnCompleted?.()
      } catch {
        /* ignore */
      }
      if (!structured && controller) {
        try {
          controller.close()
        } catch {
          /* ignore */
        }
      }
    }
  })

  const cleanup = () => {
    if (unsubscribed) return
    unsubscribed = true
    unsubscribe()
    if (opts.noInterrupt) {
      _feLog(`FE cleanup (noInterrupt) turnId=${turnId}`)
      return
    }
    _feLog(`FE cleanup -> turn/interrupt turnId=${turnId}`)
    void appServerRequest('turn/interrupt', { turnId }).catch(() => undefined)
  }

  if (structured) {
    if (signal) {
      if (signal.aborted) {
        cleanup()
        throw new DOMException('Aborted', 'AbortError')
      }
      signal.addEventListener(
        'abort',
        () => {
          finished = true
          cleanup()
        },
        { once: true },
      )
    }
    return {
      abort: cleanup,
      response: null,
    }
  }

  const readable = new ReadableStream({
    start(c) {
      controller = c
    },
    cancel() {
      finished = true
      cleanup()
    },
  })

  if (signal) {
    if (signal.aborted) {
      cleanup()
      throw new DOMException('Aborted', 'AbortError')
    }
    signal.addEventListener(
      'abort',
      () => {
        finished = true
        cleanup()
        try {
          controller?.close()
        } catch {
          /* ignore */
        }
      },
      { once: true },
    )
  }

  return {
    abort: cleanup,
    response: {
      ok: true,
      status: 200,
      body: readable,
      async text() {
        const reader = readable.getReader()
        const chunks = []
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
        }
        const bin = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
        let off = 0
        for (const c of chunks) {
          bin.set(c, off)
          off += c.length
        }
        return new TextDecoder().decode(bin)
      },
    },
  }
}

/** Best-effort parse of a raw SSE chunk into (event, data) for legacy stream/sse. */
function _parseSseChunkToEvent(chunk) {
  const lines = String(chunk || '').replace(/\r\n/g, '\n').split('\n')
  let eventName = 'message'
  const dataLines = []
  for (const line of lines) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim() || 'message'
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  const raw = dataLines.join('\n')
  if (!raw) return { eventName, data: null }
  if (raw === '[DONE]') return { eventName, data: '[DONE]' }
  try {
    return { eventName, data: JSON.parse(raw) }
  } catch {
    return { eventName, data: raw }
  }
}

/**
 * Interactive chat over stdio. Default **off for chat bytes** (Rust gateway_proxy_stream is faster).
 * Force pipe: ``localStorage.setItem('evoflow-desktop-pipe-chat', '1')``.
 * When used, fat LangGraph ``values`` frames are dropped server-side for ui_sse/agui.
 */
export function shouldUseAppServerChatPipe() {
  if (typeof window === 'undefined') return false
  const isTauri = !!(window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__ || window.isTauri)
  if (!isTauri) return false
  try {
    const flag = localStorage.getItem('evoflow-desktop-pipe-chat')
    if (flag === '1' || flag === 'true') return true
    if (flag === '0' || flag === 'false') return false
  } catch {
    /* ignore */
  }
  return false
}

/**
 * Non-stream JSON Gateway calls over stdio when warm.
 * Independent opt-out: ``evoflow-desktop-pipe-api=0``.
 */
export function shouldUseAppServerApiPipe() {
  if (typeof window === 'undefined') return false
  const isTauri = !!(window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__ || window.isTauri)
  if (!isTauri) return false
  try {
    const flag = localStorage.getItem('evoflow-desktop-pipe-api')
    if (flag === '0' || flag === 'false') return false
    if (flag === '1' || flag === 'true') return true
  } catch {
    /* ignore */
  }
  return _warm
}
