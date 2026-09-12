/**
 * Stream final diagnostics — why assistant body disappears after AG-UI stream ends.
 *
 * Enable in DevTools console:
 *   localStorage.setItem('EVOFLOW_DEBUG_STREAM_FINAL', '1'); location.reload()
 * Filter console by: [stream-final]
 */
import type { MessageSegment } from '../chat-types.js'
import type { AgUiTurnState } from './agui-turn-reducer.js'
import { projectAgUiToStreamTurnFields } from './agui-turn-reducer.js'
import { flattenStreamDisplayText } from '../../lib/chat-normalize.js'

const PREFIX = '[stream-final]'

function enabled(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem('EVOFLOW_DEBUG_STREAM_FINAL') === '1'
}

let bootLogged = false

function bootOnce() {
  if (!bootLogged) {
    bootLogged = true
    console.info(
      `${PREFIX} debug on — filter by "${PREFIX}"; disable: localStorage.setItem('EVOFLOW_DEBUG_STREAM_FINAL','0')`,
    )
  }
}

export function sfLog(step: string, detail?: Record<string, unknown>): void {
  if (!enabled()) return
  bootOnce()
  if (detail && Object.keys(detail).length > 0) {
    console.info(`${PREFIX} ${step}`, detail)
  } else {
    console.info(`${PREFIX} ${step}`)
  }
}

export function sfWarn(step: string, detail?: Record<string, unknown>): void {
  if (!enabled()) return
  bootOnce()
  if (detail) console.warn(`${PREFIX} ${step}`, detail)
  else console.warn(`${PREFIX} ${step}`)
}

function clip(s: unknown, max = 160): string {
  const t = String(s ?? '').trim()
  if (!t) return ''
  return t.length > max ? `${t.slice(0, max)}…` : t
}

export function sfSummarizeSegments(segs: MessageSegment[] | undefined | null): Record<string, unknown> {
  const list = Array.isArray(segs) ? segs : []
  const textSegs = list.filter((s) => s.kind === 'text')
  const reasoningSegs = list.filter((s) => s.kind === 'text' ? false : s.kind === 'reasoning')
  const toolSegs = list.filter((s) => s.kind === 'tools')
  return {
    count: list.length,
    textCount: textSegs.length,
    reasoningCount: reasoningSegs.length,
    toolsSlotCount: toolSegs.length,
    plain: clip(flattenStreamDisplayText(list, '')),
    kinds: list.map((s) => s.kind),
    seqs: list.map((s) => (s as { seq?: number }).seq ?? null),
  }
}

export function sfSummarizeAgUi(agui: AgUiTurnState | null | undefined): Record<string, unknown> {
  if (!agui) return { hasAgui: false }
  const proj = projectAgUiToStreamTurnFields(agui)
  const openMsgs = [...agui.messages.values()].filter((m) => !m.closed)
  return {
    hasAgui: true,
    runId: agui.runId,
    finished: agui.finished,
    openMessageCount: openMsgs.length,
    openAssistantText: clip(proj.openText),
    timeline: sfSummarizeSegments(proj.timeline),
    compatClosedCount: agui.compatSegments?.length ?? 0,
    messageIds: [...agui.messages.keys()].slice(0, 8),
  }
}

export function sfSummarizeRowsTail(rows: { role?: string; text?: string; segments?: MessageSegment[] }[]): Record<string, unknown> {
  const tail = rows.slice(-4)
  return {
    total: rows.length,
    tail: tail.map((row, i) => ({
      i: rows.length - tail.length + i,
      role: row.role,
      text: clip(row.text),
      segments: sfSummarizeSegments(row.segments as MessageSegment[]),
    })),
  }
}
