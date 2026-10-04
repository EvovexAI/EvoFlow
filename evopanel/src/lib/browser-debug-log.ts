// On-screen debug log for the browser panel. Renders the most recent browser
// tool / WS / viewport events so you can see what's happening without opening
// DevTools. The store is module-level so any of the browser-* helpers can
// push events without prop-drilling.

export type BrowserDebugEntry = {
  ts: number
  level: 'log' | 'warn' | 'error'
  message: string
}

const MAX_ENTRIES = 40
const listeners = new Set<() => void>()
let entries: BrowserDebugEntry[] = []

function notify() {
  for (const fn of listeners) {
    try {
      fn()
    } catch {
      /* ignore */
    }
  }
}

function push(level: BrowserDebugEntry['level'], message: string) {
  entries = [...entries, { ts: Date.now(), level, message }].slice(-MAX_ENTRIES)
  notify()
}

export function dbgLog(message: string) {
  // Forward to console for DevTools / Tauri logger
  // eslint-disable-next-line no-console
  console.log(message)
  push('log', message)
}

export function dbgWarn(message: string) {
  // eslint-disable-next-line no-console
  console.warn(message)
  push('warn', message)
}

export function dbgError(message: string) {
  // eslint-disable-next-line no-console
  console.error(message)
  push('error', message)
}

export function subscribeBrowserDebug(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getBrowserDebugSnapshot(): BrowserDebugEntry[] {
  return entries
}

export function clearBrowserDebug() {
  entries = []
  notify()
}
