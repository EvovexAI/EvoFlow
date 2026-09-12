/**
 * Map AppRun status → overlay control buttons visibility.
 * Pure helper for overlay / history row actions.
 */

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'canceled'])

/**
 * @param {string} status
 * @returns {{ canPause: boolean, canResume: boolean, canCancel: boolean, isTerminal: boolean }}
 */
export function appRunControlFlags(status) {
  const s = String(status || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
  const isTerminal = TERMINAL.has(s)
  if (isTerminal) {
    return { canPause: false, canResume: false, canCancel: false, isTerminal: true }
  }
  if (s === 'paused') {
    return { canPause: false, canResume: true, canCancel: true, isTerminal: false }
  }
  // executing / running / planned / plan_ready / …
  return { canPause: true, canResume: false, canCancel: true, isTerminal: false }
}
