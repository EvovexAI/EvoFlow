/**
 * Drive the Computer Use screen-edge glow from AG-UI tool-call events.
 * Mirrors browser-panel-agui: only lights when node_repl (or CUA MCP tools)
 * actually touch computer-use APIs.
 */

import {
  beginCuaGlowOverlay,
  endCuaGlowOverlay,
  hideCuaGlowOverlayForced,
  touchCuaGlowOverlay,
} from './cua-glow-overlay.js'

/**
 * Detect Computer Use intent in streamed / complete node_repl args.
 * Excludes browser-only cells so glow does not appear for browser-use.
 */
export const NODE_REPL_COMPUTER_USE_INTENT_RE = new RegExp(
  [
    'agent\\.computerUse\\b',
    '\\bcomputerUse\\s*\\.',
    'zcode\\.node-repl\\.computer-use-bridge',
    'computer-use-bridge',
    // Official MCP computer_use tool surface (if ever routed through the same cell)
    'mcp__[^"\'\\s]*computer_use',
  ].join('|'),
  'i',
)

export function nodeReplArgsTouchComputerUse(argsText) {
  const raw = String(argsText || '')
  if (!raw) return false
  return NODE_REPL_COMPUTER_USE_INTENT_RE.test(raw)
}

export function isComputerUseToolWireName(name) {
  const n = String(name || '').trim().toLowerCase()
  if (!n) return false
  if (n === 'mcp__node_repl__js') return true
  if (n.includes('computer_use') || n.includes('computer-use')) return true
  return false
}

function resolveToolName(event, toolCalls) {
  const t = String(event?.type || '').toUpperCase()
  if (t === 'TOOL_CALL_START') {
    return String(event?.toolCallName || '').trim().toLowerCase()
  }
  const toolCallId = String(event?.toolCallId || '').trim()
  if (!toolCallId || !toolCalls) return ''
  return String(toolCalls.get(toolCallId)?.toolCallName || '').trim().toLowerCase()
}

/**
 * Feed one AG-UI tool-call event into the CUA glow controller.
 * @returns {boolean} true when the event was a Computer Use candidate
 */
export function syncCuaGlowFromAgUiEvent(aguiEvent, toolCalls) {
  const toolName = resolveToolName(aguiEvent, toolCalls)
  if (!isComputerUseToolWireName(toolName)) return false

  const type = String(aguiEvent?.type || '').toUpperCase()
  const toolCallId = String(aguiEvent?.toolCallId || '').trim()
  const tc = toolCallId ? toolCalls?.get(toolCallId) : undefined
  const isNodeRepl = toolName === 'mcp__node_repl__js'
  const touchesCua =
    !isNodeRepl || nodeReplArgsTouchComputerUse(tc?.argsText)

  if (type === 'TOOL_CALL_START' || type === 'TOOL_CALL_ARGS') {
    if (!touchesCua) {
      // Args may arrive later in the stream; keep listening via ARGS.
      return true
    }
    // begin is idempotent; ARGS refresh also resets the idle safety timer.
    beginCuaGlowOverlay(toolCallId)
    touchCuaGlowOverlay(toolCallId)
    return true
  }

  if (type === 'TOOL_CALL_RESULT' || type === 'TOOL_CALL_END') {
    if (touchesCua || !isNodeRepl) endCuaGlowOverlay(toolCallId)
    return true
  }

  if (type === 'RUN_ERROR' || type === 'RUN_FINISHED' || type === 'RUN_CANCELLED') {
    hideCuaGlowOverlayForced()
    return true
  }

  return false
}
