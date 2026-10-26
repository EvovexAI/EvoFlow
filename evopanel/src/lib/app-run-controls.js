/**
 * Map AppRun status → overlay control buttons visibility.
 * Pure helper for overlay / history row actions.
 */

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'canceled'])
// Terminal-but-recoverable: crash / failed runs can be healed via /recover.
const RECOVERABLE = new Set(['failed', 'error', 'interrupted', 'pausing'])

/**
 * @param {string} status
 * @returns {{ canPause: boolean, canResume: boolean, canCancel: boolean, canRecover: boolean, canRestore: boolean, isTerminal: boolean }}
 */
export function appRunControlFlags(status) {
  const s = String(status || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
  if (RECOVERABLE.has(s)) {
    // F-4: unified「恢复」— paused → /resume, failed/crashed → /recover.
    return { canPause: false, canResume: false, canCancel: false, canRecover: true, canRestore: true, isTerminal: true }
  }
  const isTerminal = TERMINAL.has(s)
  if (isTerminal) {
    return { canPause: false, canResume: false, canCancel: false, canRecover: false, canRestore: false, isTerminal: true }
  }
  if (s === 'paused') {
    return { canPause: false, canResume: true, canCancel: true, canRecover: false, canRestore: true, isTerminal: false }
  }
  // executing / running / planned / plan_ready / …
  return { canPause: true, canResume: false, canCancel: true, canRecover: false, canRestore: false, isTerminal: false }
}
