/**
 * ChatApp debug localStorage switches (pure; no React).
 * Extracted from ChatApp.tsx module-top helpers (P0).
 */
import { isSubtaskStreamDebugEnabled } from '../../../lib/subtask-stream-debug.js'

export function debugSubtaskTooltipEnabled(): boolean {
  try {
    return localStorage.getItem('EVOFLOW_DEBUG_SUBTASK_TOOLTIP') === '1'
  } catch {
    return false
  }
}

export function debugSubtaskFlowEnabled(): boolean {
  return isSubtaskStreamDebugEnabled()
}

export function debugAssistantDedupEnabled(): boolean {
  try {
    return localStorage.getItem('EVOFLOW_DEBUG_ASSISTANT_DEDUP') === '1'
  } catch {
    return false
  }
}

export function shortLogText(v: unknown, maxLen = 220): string {
  const s = String(v ?? '').trim()
  if (!s) return ''
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s
}
