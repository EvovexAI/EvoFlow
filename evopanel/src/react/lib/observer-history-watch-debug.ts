/**
 * Always-on console diagnostics for Feishu/IM observer history-watch.
 * Filter DevTools by ``[observer-hw]``.
 */
const PREFIX = '[observer-hw]'

export function ohwLog(step: string, detail?: Record<string, unknown>) {
  if (detail && Object.keys(detail).length > 0) {
    console.info(`${PREFIX} ${step}`, detail)
  } else {
    console.info(`${PREFIX} ${step}`)
  }
}

export function ohwWarn(step: string, detail?: Record<string, unknown>) {
  if (detail) console.warn(`${PREFIX} ${step}`, detail)
  else console.warn(`${PREFIX} ${step}`)
}
