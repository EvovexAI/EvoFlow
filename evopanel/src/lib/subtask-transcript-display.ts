import {
  joinTextContentParts,
  normalizeSubtaskResultForDisplay,
} from './subtask-result-display.js'
import { ensureSubtaskRowSegments, rowHasStructuredTimeline } from './subtask-modal-rows.js'
import { prepareSubtaskModalDisplayText } from '../react/components/SubtaskModalMessageRow.js'
import { isCompletionTailRedundant } from '../react/subagent-stream-merge.js'
import type { SubagentStreamTask } from '../react/chat-types.js'

export function normalizeSubtaskStatus(status?: string): string {
  return String(status || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
}

export function isSubtaskRunning(status?: string): boolean {
  const s = normalizeSubtaskStatus(status)
  return s === 'in_progress' || s === 'running' || s === 'executing' || s === 'active'
}

export function isSubtaskCompleted(status?: string): boolean {
  const s = normalizeSubtaskStatus(status)
  return s === 'completed' || s === 'done'
}

export function isTerminalSubtaskStatus(status?: string): boolean {
  const s = normalizeSubtaskStatus(status)
  return (
    s === 'completed' ||
    s === 'done' ||
    s === 'failed' ||
    s === 'error' ||
    s === 'cancelled' ||
    s === 'canceled' ||
    s === 'timed_out'
  )
}

function isTerminalStatus(status?: string): boolean {
  return isTerminalSubtaskStatus(status)
}

/** 侧栏卡片用：子智能体 SSE 的 phase=running 优先于陈旧的「已完成」快照 */
export function resolveSubtaskCardDisplayStatus(
  collabStatus: string | undefined,
  streamTask: SubagentStreamTask | undefined,
  mainTaskStatus?: string,
): string {
  const raw = String(collabStatus || '').trim()
  const streamPh = streamTask?.phase
  if (streamPh === 'running') return 'executing'

  const main = normalizeSubtaskStatus(mainTaskStatus)
  const mainTerminal = main === 'completed' || main === 'failed' || main === 'cancelled'
  if (mainTerminal) {
    const rawNorm = normalizeSubtaskStatus(raw)
    if (rawNorm === 'failed' || rawNorm === 'error') return 'failed'
    if (rawNorm === 'cancelled') return 'cancelled'
    if (rawNorm === 'timed_out') return 'timed_out'
    const ph = streamTask?.phase
    if (ph === 'failed' || ph === 'timed_out') return ph
    return 'completed'
  }
  if (isTerminalStatus(raw)) {
    const ph = streamTask?.phase
    if ((normalizeSubtaskStatus(raw) === 'failed' || normalizeSubtaskStatus(raw) === 'error') && ph === 'completed') {
      return 'completed'
    }
    if (isSubtaskCompleted(raw)) return raw
    return raw || 'pending'
  }
  const ph = streamTask?.phase
  if (ph === 'running') return 'executing'
  if (ph === 'completed' || ph === 'failed' || ph === 'timed_out') return ph
  if (isSubtaskRunning(raw)) return raw
  return raw || 'pending'
}

export function copyToClipboard(text: string): void {
  const t = String(text || '')
  if (!t) return
  try {
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(t)
      return
    }
  } catch {
    // fallback below
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = t
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    ta.style.top = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  } catch {
    // ignore
  }
}

function extractRowPlainTextForDedupe(r: any): string {
  const segs = r?.segments
  if (Array.isArray(segs)) {
    const t = segs
      .filter((s: any) => s?.kind === 'text')
      .map((s: any) => String(s?.text || ''))
      .join('\n')
      .trim()
    if (t) return t
  }
  return String(r?.text || '')
}

function dedupeSubtaskModalAssistantRows(rows: any[]): any[] {
  const out: any[] = []
  let accAssistant = ''
  let mergedRow: any | null = null

  const flushMerged = () => {
    if (mergedRow) {
      out.push(mergedRow)
      mergedRow = null
    }
  }

  for (const r of rows) {
    const role = r?.role
    if (role === 'user') {
      flushMerged()
      out.push(r)
      accAssistant = ''
      continue
    }
    if (role !== 'assistant' && role !== '_stream') {
      flushMerged()
      out.push(r)
      continue
    }
    if (rowHasStructuredTimeline(r)) {
      flushMerged()
      out.push(ensureSubtaskRowSegments({ ...r, role: 'assistant' }))
      accAssistant = prepareSubtaskModalDisplayText(r)
      continue
    }
    const plain = prepareSubtaskModalDisplayText(r)
    if (!plain) {
      flushMerged()
      out.push(r)
      continue
    }
    if (accAssistant.length > 0) {
      const stripped = plain.replace(/^【完成】[\s\n]*/u, '').trim()
      const redundant =
        isCompletionTailRedundant(accAssistant, plain) ||
        (stripped.length >= 16 && stripped !== plain && isCompletionTailRedundant(accAssistant, stripped))
      if (redundant) continue
    }
    const nextText = accAssistant
      ? normalizeSubtaskResultForDisplay(joinTextContentParts([accAssistant, plain]))
      : plain
    if (!mergedRow) {
      mergedRow = { ...r, text: nextText, segments: undefined }
    } else {
      mergedRow = { ...mergedRow, text: nextText, tools: r.tools?.length ? r.tools : mergedRow.tools }
    }
    accAssistant = nextText
  }
  flushMerged()
  return out
}

export function buildSubtaskModalRowsForDisplay(options: {
  payload: {
    rows?: unknown[]
    emptyConversation?: boolean
  } | null
  transcriptSyntheticText: string
  modalTools: unknown[]
  preferSubtaskStreamOverFetchedHistory: boolean
  modalStreamTask?: SubagentStreamTask | null
  modalStatus: string
  modalSending: boolean
}): any[] {
  const {
    payload,
    transcriptSyntheticText,
    modalTools,
    preferSubtaskStreamOverFetchedHistory,
    modalStreamTask,
    modalStatus,
    modalSending,
  } = options
  if (!payload) return []

  const rawRows = payload.rows
  const hasRows = Array.isArray(rawRows) && rawRows.length > 0
  const syntheticRow = [
    ensureSubtaskRowSegments({
      role: 'assistant',
      text: transcriptSyntheticText,
      tools: modalTools,
      timestamp: Date.now(),
    }),
  ]
  let base: any[]
  if (preferSubtaskStreamOverFetchedHistory) {
    base = syntheticRow
  } else if (hasRows) {
    base = rawRows as any[]
    const live = String(transcriptSyntheticText || '').trim()
    const streaming =
      modalStreamTask?.phase === 'running' || isSubtaskRunning(modalStatus) || modalSending
    if (live && streaming) {
      const last = base[base.length - 1]
      const lastText = last ? extractRowPlainTextForDedupe(last) : ''
      if (!last || isCompletionTailRedundant(lastText, live)) {
        // keep rows as-is
      } else if (last?.role === 'assistant' || last?.role === '_stream') {
        base = [
          ...base.slice(0, -1),
          ensureSubtaskRowSegments({
            ...last,
            text: live,
            tools: modalTools.length ? modalTools : last.tools,
          }),
        ]
      } else {
        base = [
          ensureSubtaskRowSegments({
            role: '_stream',
            text: live,
            tools: modalTools,
            timestamp: Date.now(),
          }),
        ]
      }
    }
  } else if (
    payload.emptyConversation &&
    !String(transcriptSyntheticText || '').trim() &&
    !(Array.isArray(modalTools) && modalTools.length > 0)
  ) {
    base = []
  } else if (String(transcriptSyntheticText || '').trim()) {
    base = syntheticRow
  } else {
    base = []
  }

  const mapped = base.map((r: any) => {
    const role = String(r?.role || '').trim()
    if (role === 'user') {
      return { ...r, text: prepareSubtaskModalDisplayText(r), segments: undefined }
    }
    if (role === 'assistant' || role === '_stream') {
      if (rowHasStructuredTimeline(r)) {
        return ensureSubtaskRowSegments({ ...r, role: 'assistant' })
      }
      return ensureSubtaskRowSegments({
        ...r,
        role: 'assistant',
        text: prepareSubtaskModalDisplayText(r),
        segments: undefined,
      })
    }
    return r
  })
  return dedupeSubtaskModalAssistantRows(mapped)
}
