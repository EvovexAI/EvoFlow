import { rightStageStore } from './right-stage-store.js'

export type EnsureInteractiveTerminalStageInput = {
  /** Absolute workspace cwd for the shell. */
  cwd?: string
  title?: string
  sessionKey?: string
  threadId?: string
  /** Force a brand-new tab (ZCode: each + Terminal creates a new instance). */
  forceNew?: boolean
}

let _ptySeq = 0

/** Open or activate an interactive PTY terminal tab (not tool-output logs). */
export function ensureInteractiveTerminalStage(input: EnsureInteractiveTerminalStageInput = {}) {
  const sessionKey = String(input.sessionKey || '').trim() || undefined
  const cwd = String(input.cwd || '').trim()
  const threadId = String(input.threadId || '').trim()
  const forceNew = input.forceNew !== false
  const id = forceNew
    ? `pty-${Date.now()}-${++_ptySeq}`
    : `pty:${cwd || threadId || sessionKey || 'default'}`
  const baseTitle = String(input.title || '').trim() || (cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : '') || '终端'
  rightStageStore.show({
    kind: 'interactive-terminal',
    id,
    title: baseTitle,
    layout: 'half',
    sessionKey,
    forceExpand: true,
    data: {
      cwd,
      threadId,
      interactive: true,
    },
  })
  return id
}
