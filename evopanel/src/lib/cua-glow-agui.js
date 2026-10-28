/**
 * Drive the Computer Use top indicator from AG-UI tool-call events.
 *
 * 对齐 ZCode 2026-09-14 修复：判定锚点是 ``setupComputerUseRuntime``（每个 CUA cell
 * 必须带的 bootstrap），不再抠动作名词表。Browser Use 不含该引导，不会误亮。
 */

import {
  beginCuaGlowOverlay,
  hideCuaGlowOverlayForced,
  touchCuaGlowOverlay,
} from './cua-glow-overlay.js'

/**
 * ZCode 权威锚点 + 兼容旧写法。
 * @see ZCode docs/cua/2026-09-14-windows-cua-indicator-repair-spec.md
 */
export const NODE_REPL_COMPUTER_USE_INTENT_RE = new RegExp(
  [
    'setupComputerUseRuntime',
    'computer-use-client\\.mjs',
    'ZCODE_CUA_PLUGIN_ROOT',
    'agent\\.computerUse\\b',
    '\\bcomputerUse\\s*\\.',
    'zcode\\.node-repl\\.computer-use-bridge',
    'computer-use-bridge',
    'mcp__[^"\'\\s]*computer[_-]use',
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
 * Feed one AG-UI tool-call event into the CUA indicator controller.
 * V4 只闸 TEXT_*；TOOL_CALL_* 仍走这条副作用热路径。
 * @returns {boolean} true when the event was a Computer Use candidate
 */
export function syncCuaGlowFromAgUiEvent(aguiEvent, toolCalls) {
  const toolName = resolveToolName(aguiEvent, toolCalls)
  if (!isComputerUseToolWireName(toolName)) return false

  const type = String(aguiEvent?.type || '').toUpperCase()
  const toolCallId = String(aguiEvent?.toolCallId || '').trim()
  const tc = toolCallId ? toolCalls?.get(toolCallId) : undefined
  const isNodeRepl = toolName === 'mcp__node_repl__js'
  const touchesCua = !isNodeRepl || nodeReplArgsTouchComputerUse(tc?.argsText)

  if (type === 'TOOL_CALL_START' || type === 'TOOL_CALL_ARGS') {
    if (!touchesCua) return true
    beginCuaGlowOverlay(toolCallId)
    touchCuaGlowOverlay(toolCallId)
    return true
  }

  if (type === 'TOOL_CALL_RESULT' || type === 'TOOL_CALL_END') {
    // ZCode: tool-ended does NOT hide — refresh idle only; hide via 30s /
    // glow-status poll / RUN_ERROR / user stop.
    if (touchesCua || !isNodeRepl) touchCuaGlowOverlay(toolCallId)
    return true
  }

  if (type === 'RUN_ERROR' || type === 'RUN_CANCELLED') {
    hideCuaGlowOverlayForced()
    void import('./cua-glow-poll.js').then((m) => m.clearCuaGlowStatusRemote?.())
    return true
  }

  return false
}
