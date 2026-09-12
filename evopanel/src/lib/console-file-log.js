/**
 * Mirror browser ``console.*`` and global errors to ``~/.evoflow/logs/frontend-YYYY-MM-DD.log``
 * (Tauri ``append_frontend_log``). Enabled for desktop builds so release packages are debuggable.
 */

import { isTauri } from './panel-login.js'

const MAX_LINE = 12_000
let installed = false

function formatConsoleArgs(args) {
  return args
    .map((a) => {
      if (a instanceof Error) {
        return a.stack || a.message || String(a)
      }
      if (typeof a === 'string') return a
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
}

async function writeLine(level, message) {
  if (!isTauri || !window.__TAURI__) return
  const text = String(message || '').slice(0, MAX_LINE)
  if (!text) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('append_frontend_log', {
      level: level === 'log' ? 'info' : level,
      message: text,
    })
  } catch {
    /* best-effort */
  }
}

/**
 * Patch ``console.log/info/warn/error/debug`` and window error handlers (idempotent).
 */
export function installConsoleFileLog() {
  if (installed || typeof window === 'undefined' || !isTauri) return
  installed = true

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level]?.bind(console)
    if (!orig) continue
    console[level] = (...args) => {
      orig(...args)
      void writeLine(level, formatConsoleArgs(args))
    }
  }

  window.addEventListener('error', (ev) => {
    void writeLine('error', `[uncaught] ${ev.message} @ ${ev.filename || '?'}:${ev.lineno || '?'}`)
  })

  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason
    const msg = r instanceof Error ? r.stack || r.message : String(r ?? '')
    void writeLine('error', `[unhandledrejection] ${msg}`)
  })
}
