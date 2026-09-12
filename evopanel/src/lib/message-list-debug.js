/** Chat message list scroll / virtual-list diagnostics.
 * Enable: localStorage.setItem('EVOFLOW_MESSAGE_LIST_DEBUG', '1')
 * Export: __evoflowMessageListDebug.copy()
 */
const PREFIX = '[message-list]'
const MAX = 500
const ring = []
let bootLogged = false
let scrollSampleTimer = 0
let pendingScrollSample = null

export function messageListDebugEnabled() {
  try {
    return localStorage.getItem('EVOFLOW_MESSAGE_LIST_DEBUG') === '1'
  } catch {
    return false
  }
}

export function mlScrollSnapshot(el) {
  if (!el) return {}
  const scrollTop = el.scrollTop
  const scrollHeight = el.scrollHeight
  const clientHeight = el.clientHeight
  return {
    scrollTop: Math.round(scrollTop * 10) / 10,
    scrollHeight: Math.round(scrollHeight),
    clientHeight: Math.round(clientHeight),
    distBottom: Math.round(scrollHeight - (scrollTop + clientHeight)),
  }
}

export function mlLog(event, detail = {}) {
  if (!messageListDebugEnabled()) return
  if (!bootLogged) {
    bootLogged = true
    console.info(
      `${PREFIX} debug on — filter Console by "${PREFIX}"; export: __evoflowMessageListDebug.copy()`,
    )
  }
  const row = { t: Date.now(), event, ...detail }
  ring.push(row)
  if (ring.length > MAX) ring.shift()
  if (detail && Object.keys(detail).length > 0) console.info(`${PREFIX} ${event}`, detail)
  else console.info(`${PREFIX} ${event}`)
}

/** Throttle high-frequency scroll samples while wheel/drag is active. */
export function mlLogScrollSample(detail = {}) {
  if (!messageListDebugEnabled()) return
  pendingScrollSample = detail
  if (scrollSampleTimer) return
  scrollSampleTimer = window.setTimeout(() => {
    scrollSampleTimer = 0
    if (pendingScrollSample) mlLog('scroll-sample', pendingScrollSample)
    pendingScrollSample = null
  }, 160)
}

export function dumpMessageListDebug() {
  return [...ring]
}

export function installMessageListDebugGlobal() {
  if (typeof window === 'undefined') return
  window.__evoflowMessageListDebug = {
    dump: dumpMessageListDebug,
    clear: () => {
      ring.length = 0
    },
    copy: async () => {
      const text = JSON.stringify(dumpMessageListDebug(), null, 2)
      try {
        await navigator.clipboard.writeText(text)
        console.info(`${PREFIX} copied ${ring.length} events to clipboard`)
      } catch {
        console.info(`${PREFIX} copy failed — use JSON.stringify(__evoflowMessageListDebug.dump())`)
      }
      return text
    },
  }
}
