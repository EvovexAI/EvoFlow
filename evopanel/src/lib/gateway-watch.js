/**
 * Gateway lifecycle watch — durable breadcrumbs for「连接极不稳定」排查。
 *
 * Grep: ``[gateway-watch]``
 * Snapshot: ``window.__EVOFLOW_GATEWAY_WATCH__``
 * File (desktop): ``~/.evoflow-dev/logs/frontend-*.log`` via append_frontend_log
 *
 * Events:
 *   - probe_ok / probe_fail   (throttled fail)
 *   - lost                    (ok → down edge)
 *   - recovered               (down → ok edge)
 *   - guardian_external_wait  (operator-owned Gateway, skip fake reload)
 *   - guardian_reload         (owned sidecar reload)
 *   - guardian_wedged_skip_reload (process alive, HTTP dead — do not kill)
 *   - guardian_reload_langgraph (split model: restart Agent Runtime only)
 */

const RING_MAX = 100
/** @type {Array<Record<string, unknown>>} */
const _ring = []

let _state = /** @type {'unknown' | 'ok' | 'down'} */ ('unknown')
let _lastOkAt = 0
let _lastDownAt = 0
let _failStreak = 0
let _lastFailLogAt = 0
let _invokeAppend = null

function _now() {
  return Date.now()
}

function _persistToWindow() {
  if (typeof window === 'undefined') return
  window.__EVOFLOW_GATEWAY_WATCH__ = {
    state: _state,
    lastOkAt: _lastOkAt || null,
    lastDownAt: _lastDownAt || null,
    failStreak: _failStreak,
    lastOkAgeMs: _lastOkAt ? _now() - _lastOkAt : null,
    lastDownAgeMs: _lastDownAt ? _now() - _lastDownAt : null,
    recent: _ring.slice(-25),
  }
}

function _appendFrontendFile(level, message) {
  try {
    if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return
    if (!_invokeAppend) {
      _invokeAppend = import('@tauri-apps/api/core')
        .then((m) => m.invoke)
        .catch(() => null)
    }
    void _invokeAppend.then((invoke) => {
      if (typeof invoke !== 'function') return
      return invoke('append_frontend_log', {
        level: level || 'info',
        message: String(message || ''),
      }).catch(() => {})
    })
  } catch {
    /* ignore */
  }
}

/**
 * @param {string} event
 * @param {Record<string, unknown>} [detail]
 * @param {{ level?: 'info' | 'warn' | 'error', forceFile?: boolean }} [opts]
 */
export function noteGatewayWatch(event, detail = {}, opts = {}) {
  const ts = _now()
  const entry = { ts, iso: new Date(ts).toISOString(), event, ...detail }
  _ring.push(entry)
  while (_ring.length > RING_MAX) _ring.shift()
  _persistToWindow()

  const level = opts.level || (event === 'lost' || event === 'probe_fail' ? 'warn' : 'info')
  const payload = JSON.stringify(detail || {}).slice(0, 350)
  const line = `[gateway-watch] event=${event} ${payload}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.info(line)

  // Always file-log transitions; throttle probe_fail noise.
  const isEdge =
    event === 'lost' ||
    event === 'recovered' ||
    event === 'guardian_external_wait' ||
    event === 'guardian_reload' ||
    event === 'guardian_wedged_skip_reload' ||
    event === 'guardian_reload_langgraph'
  if (isEdge || opts.forceFile || level === 'error') {
    _appendFrontendFile(level === 'info' ? 'info' : level === 'error' ? 'error' : 'warn', line)
  }
}

/**
 * Record a /health (liveness or ready) probe outcome. Logs edges + throttled fails.
 * @param {boolean} ok
 * @param {Record<string, unknown>} [meta]
 */
export function noteGatewayProbeResult(ok, meta = {}) {
  const ts = _now()
  if (ok) {
    const was = _state
    _failStreak = 0
    if (was !== 'ok') {
      noteGatewayWatch(
        'recovered',
        {
          was,
          downForMs: _lastDownAt ? ts - _lastDownAt : 0,
          ...meta,
        },
        { forceFile: true },
      )
    }
    _state = 'ok'
    _lastOkAt = ts
    _persistToWindow()
    return
  }

  _failStreak += 1
  const was = _state
  if (was === 'ok' || was === 'unknown') {
    noteGatewayWatch(
      'lost',
      {
        was,
        failStreak: _failStreak,
        lastOkAgeMs: _lastOkAt ? ts - _lastOkAt : null,
        ...meta,
      },
      { level: 'warn', forceFile: true },
    )
  }
  _state = 'down'
  _lastDownAt = ts

  // Throttle probe_fail to ≤1 / 10s (panel-stream spam otherwise).
  if (ts - _lastFailLogAt > 10_000) {
    _lastFailLogAt = ts
    noteGatewayWatch('probe_fail', { failStreak: _failStreak, ...meta }, { level: 'warn', forceFile: true })
  }
  _persistToWindow()
}

/** Snapshot for diagnostics / about panel. */
export function getGatewayWatchSnapshot() {
  return {
    state: _state,
    lastOkAt: _lastOkAt || null,
    lastDownAt: _lastDownAt || null,
    failStreak: _failStreak,
    recent: _ring.slice(-25),
  }
}
