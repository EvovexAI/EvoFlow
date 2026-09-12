/** Session sidebar / selection diagnostics.
 * Enable: localStorage.setItem('EVOFLOW_SESSION_LIST_DEBUG','1')
 * Or selection only: localStorage.setItem('EVOFLOW_SESSION_SELECT_DEBUG','1')
 * Export: __evoflowSessionListDebug.copy() */
const MAX = 400
const ring = []

export function sessionListDebugEnabled() {
  try {
    return localStorage.getItem('EVOFLOW_SESSION_LIST_DEBUG') === '1'
  } catch {
    return false
  }
}

export function sessionSelectDebugEnabled() {
  try {
    return (
      localStorage.getItem('EVOFLOW_SESSION_SELECT_DEBUG') === '1' ||
      sessionListDebugEnabled()
    )
  } catch {
    return false
  }
}

/** Shorten sessionKey for logs */
export function skTail(key) {
  const k = String(key || '').trim()
  if (!k) return '(empty)'
  return k.length > 24 ? `…${k.slice(-20)}` : k
}

function pushRing(row) {
  ring.push(row)
  if (ring.length > MAX) ring.shift()
}

export function slLog(event, detail = {}) {
  if (!sessionListDebugEnabled()) return
  const row = { t: Date.now(), kind: 'list', event, ...detail }
  pushRing(row)
}

export function ssLog(event, detail = {}) {
  if (!sessionSelectDebugEnabled()) return
  const row = { t: Date.now(), kind: 'select', event, ...detail }
  pushRing(row)
}

export function dumpSessionListDebug() {
  return [...ring]
}

export function installSessionListDebugGlobal() {
  if (typeof window === 'undefined') return
  window.__evoflowSessionListDebug = {
    dump: dumpSessionListDebug,
    clear: () => {
      ring.length = 0
    },
    copy: async () => {
      const text = JSON.stringify(dumpSessionListDebug(), null, 2)
      try {
        await navigator.clipboard.writeText(text)
        /* copied */
      } catch {
        /* copy failed — use dump() */
      }
      return text
    },
    enable: () => {
      try {
        localStorage.setItem('EVOFLOW_SESSION_SELECT_DEBUG', '1')
        localStorage.setItem('EVOFLOW_SESSION_LIST_DEBUG', '1')
      } catch {
        /* ignore */
      }
      /* debug enabled — reload page, then __evoflowSessionListDebug.copy() */
    },
  }
}
