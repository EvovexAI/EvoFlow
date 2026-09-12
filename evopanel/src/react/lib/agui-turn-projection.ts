/**
 * AgUiTurnState → TurnDisplayView (ordered slots for rendering).
 */
import type { AgUiToolCall, AgUiTurnState } from './agui-turn-reducer.js'
import { normalizeStreamStatusLabel } from './stream-status-label.js'

export type TurnDisplaySlot =
  | { kind: 'thinking-wait'; label: string }
  | { kind: 'activity'; label: string }
  | { kind: 'reasoning-fold'; messageId: string; text: string; isStreaming: boolean }
  | { kind: 'text-block'; messageId: string; text: string; isStreaming: boolean; phase?: 'pre_tools' | 'post_tools' }
  | { kind: 'tool-card'; tool: AgUiToolCallView }

export type AgUiToolCallView = AgUiToolCall & {
  argsComplete: boolean
}

export type TurnDisplayView = {
  runId: string
  finished: boolean
  slots: TurnDisplaySlot[]
}

function toolToView(tc: AgUiToolCall): AgUiToolCallView {
  let argsComplete
  try {
    if (tc.argsText.trim()) JSON.parse(tc.argsText)
    argsComplete = !!tc.argsText.trim()
  } catch {
    argsComplete = false
  }
  return { ...tc, argsComplete }
}

/**
 * 流式状态行文案：后端统一推送，前端只消费 state.activity，不做任何内容推断。
 */
function resolveStreamingStatusLabel(state: AgUiTurnState): string {
  const explicit = normalizeStreamStatusLabel(state.activity || '')
  if (explicit) return explicit
  return ''
}

export function projectAgUiTurnDisplay(state: AgUiTurnState, opts?: { isStreaming?: boolean }): TurnDisplayView {
  const isStreaming = opts?.isStreaming ?? !state.finished
  const slots: TurnDisplaySlot[] = []
  for (const entry of state.order) {
    if (entry.kind === 'reasoning') {
      const msg = state.messages.get(entry.messageId)
      if (!msg) continue
      const text = String(msg.content || '')
      if (!text.trim() && msg.closed) continue
      slots.push({
        kind: 'reasoning-fold',
        messageId: entry.messageId,
        text,
        isStreaming: isStreaming && !msg.closed,
      })
    } else if (entry.kind === 'tool') {
      const tc = state.toolCalls.get(entry.toolCallId)
      if (tc) slots.push({ kind: 'tool-card', tool: toolToView(tc) })
    } else if (entry.kind === 'text') {
      const msg = state.messages.get(entry.messageId)
      if (!msg) continue
      const text = String(msg.content || '')
      if (!text.trim() && msg.closed) continue
      slots.push({
        kind: 'text-block',
        messageId: entry.messageId,
        text,
        isStreaming: isStreaming && !msg.closed,
      })
    }
  }

  // 流式进行中：始终在气泡底部追加一行实时状态（由后端统一推送，前端只消费），
  // run 结束后由 isStreaming=false 自然移除。
  if (isStreaming) {
    const label = resolveStreamingStatusLabel(state)
    if (label) {
      slots.push({
        kind: 'thinking-wait',
        label,
      })
    }
  }

  return {
    runId: state.runId,
    finished: state.finished,
    slots,
  }
}

/** Map TurnDisplayView slots → AssistantBubbleSlot-compatible list. */
export function aguiSlotsToBubbleSlots(
  view: TurnDisplayView,
): import('./message-row-display-plan.js').AssistantBubbleSlot[] {
  const out: import('./message-row-display-plan.js').AssistantBubbleSlot[] = []
  let ord = 0
  for (const slot of view.slots) {
    if (slot.kind === 'thinking-wait') {
      out.push({ kind: 'thinking-wait', label: slot.label })
    } else if (slot.kind === 'activity') {
      out.push({ kind: 'thinking-wait', label: slot.label })
    } else if (slot.kind === 'reasoning-fold') {
      ord += 1
      out.push({
        kind: 'top-reasoning',
        text: slot.text,
        label: '思考过程',
        isStreamingActive: slot.isStreaming,
        ord,
      })
    } else if (slot.kind === 'text-block') {
      if (slot.isStreaming) {
        out.push({ kind: 'live-tail', text: slot.text, isStreaming: true })
      } else {
        out.push({ kind: 'plain-body', text: slot.text, isStreaming: false })
      }
    } else if (slot.kind === 'tool-card') {
      const prev = out[out.length - 1]
      if (prev?.kind === 'tool-row') {
        prev.toolCallIds.push(slot.tool.toolCallId)
      } else {
        out.push({
          kind: 'tool-row',
          toolCallIds: [slot.tool.toolCallId],
        })
      }
    }
  }
  return out
}
