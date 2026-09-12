/**
 * Shared subtask card / workflow node live preview text.
 */

import type { SubagentStreamTask } from '../react/chat-types.js'

type SubagentStreamTaskMap = Record<string, SubagentStreamTask>
import { findSubagentLiveForCollabSubtask } from './subtask-stream-bind.js'
import { latestLiveSegmentForTicker, sanitizeSubtaskLiveTicker } from './subtask-live-preview.js'
import { normalizeSubtaskResultForDisplay } from './subtask-result-display.js'

const GENERIC_WAIT_RE =
  /^(已派发[，,]?等待|等待.*输出|（已启动[，,]?等待|Subagent executing|Progress \d+%)/i

export function isGenericSubtaskWaitHint(text: string): boolean {
  const t = String(text || '').trim()
  if (!t) return false
  if (GENERIC_WAIT_RE.test(t)) return true
  if (/await subtask_outcome_report/i.test(t)) return true
  return false
}

export function stripSubtaskCompletionPrefix(text: string): string {
  return String(text || '')
    .replace(/^【(?:完成|已取消)】[\s\n]*/u, '')
    .trim()
}

export function latestLiveSegment(full: string): string {
  return latestLiveSegmentForTicker(full)
}

export function resolveSubtaskLivePreview(input: {
  subtaskId: string
  fallbackTitle: string
  running: boolean
  terminal: boolean
  subagentTasks?: SubagentStreamTaskMap
  statusHint?: string
  terminalFallback?: string
}): { previewText: string; hasLiveContent: boolean; streamMatched: boolean } {
  const liveFromStream = findSubagentLiveForCollabSubtask(
    input.subagentTasks,
    input.subtaskId,
    input.fallbackTitle,
  )
  const streamFull = (liveFromStream.text || '').trim()
  const live = stripSubtaskCompletionPrefix(
    normalizeSubtaskResultForDisplay(
      sanitizeSubtaskLiveTicker(streamFull) || latestLiveSegment(streamFull) || '',
    ),
  ).trim()

  const statusHint = String(input.statusHint || '').trim()
  const terminalFallback = String(input.terminalFallback || '').trim()

  if (live) {
    return { previewText: live, hasLiveContent: true, streamMatched: liveFromStream.matched }
  }

  if (input.running) {
    if (liveFromStream.matched) {
      return { previewText: '运行中…', hasLiveContent: false, streamMatched: true }
    }
    if (statusHint && !isGenericSubtaskWaitHint(statusHint)) {
      return { previewText: statusHint, hasLiveContent: false, streamMatched: false }
    }
    return { previewText: '运行中…', hasLiveContent: false, streamMatched: false }
  }

  if (input.terminal && terminalFallback) {
    return { previewText: terminalFallback, hasLiveContent: true, streamMatched: liveFromStream.matched }
  }

  return { previewText: '', hasLiveContent: false, streamMatched: liveFromStream.matched }
}
