/** Console diagnostics for stream resume. Filter DevTools by `[stream-resume]`. */
const PREFIX = '[stream-resume]'

function debugEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem('evoflow-stream-resume-debug') === '1'
}

let bootLogged = false

export function srLog(step: string, detail?: Record<string, unknown>) {
  if (!debugEnabled()) return
  if (!bootLogged) {
    bootLogged = true
    console.info(
      `${PREFIX} debug on — filter console by "${PREFIX}"; disable with localStorage.setItem('evoflow-stream-resume-debug','0')`,
    )
  }
  if (detail && Object.keys(detail).length > 0) {
    console.info(`${PREFIX} ${step}`, detail)
  } else {
    console.info(`${PREFIX} ${step}`)
  }
}

export function srWarn(step: string, detail?: Record<string, unknown>) {
  if (!debugEnabled()) return
  if (detail) console.warn(`${PREFIX} ${step}`, detail)
  else console.warn(`${PREFIX} ${step}`)
}
