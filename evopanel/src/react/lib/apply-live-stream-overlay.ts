/**
 * Overlay live text/reasoning onto a structural DisplayRow without rebuilding tools/timeline shape.
 * Updates the trailing open text / reasoning segments when present; always refreshes scalar fields.
 * While streaming, body/reasoning are tail-windowed so React/Markdown DOM stay bounded.
 */
import type { DisplayRow, MessageSegment } from '../chat-types.js'
import type { LiveStreamSnapshot } from './live-stream-store.js'
import {
  liveStreamDisplayTail,
  STREAM_PLAIN_DISPLAY_MAX_CHARS,
  STREAM_REASONING_DISPLAY_MAX_CHARS,
} from './markdown-stream-paint.js'

function patchTrailingSegment(
  segments: MessageSegment[] | undefined,
  kind: 'text' | 'reasoning',
  nextText: string,
): MessageSegment[] | undefined {
  if (!Array.isArray(segments) || !segments.length) return segments
  let last = -1
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i]?.kind === kind) {
      last = i
      break
    }
  }
  if (last < 0) {
    if (!String(nextText || '').length) return segments
    // 首轮无工具：正文已先入时间线时，思考应插在正文前，避免「正文在思考上面」
    if (kind === 'reasoning') {
      const hasTools = segments.some((s) => s.kind === 'tools')
      const firstText = segments.findIndex(
        (s) => s.kind === 'text' && String(s.text || '').trim(),
      )
      if (!hasTools && firstText >= 0) {
        return [
          ...segments.slice(0, firstText),
          { kind, text: nextText } as MessageSegment,
          ...segments.slice(firstText),
        ]
      }
    }
    return [...segments, { kind, text: nextText } as MessageSegment]
  }
  // 思考：仅当末段之后已有工具时才新开一轮；仅有正文跟在后面仍属同轮，回写原槽位。
  if (kind === 'reasoning' && last < segments.length - 1) {
    const hasToolsAfter = segments.slice(last + 1).some((s) => s.kind === 'tools')
    if (hasToolsAfter) {
      if (!String(nextText || '').length) return segments
      return [...segments, { kind, text: nextText } as MessageSegment]
    }
  }
  const cur = segments[last]
  if (String(cur.text || '') === nextText) return segments
  const out = segments.slice()
  out[last] = { ...cur, text: nextText }
  return out
}

export function applyLiveStreamOverlay(
  row: DisplayRow,
  live: LiveStreamSnapshot | null | undefined,
): DisplayRow {
  if (!row || !live || !live.sessionKey) return row
  if (!live.streaming && !live.epoch) return row

  const text = live.streaming
    ? liveStreamDisplayTail(live.text, STREAM_PLAIN_DISPLAY_MAX_CHARS)
    : live.text
  const reasoning = live.streaming
    ? liveStreamDisplayTail(live.reasoning, STREAM_REASONING_DISPLAY_MAX_CHARS)
    : live.reasoning
  const prevText = String(row.text || '')
  const prevReasoning = String(row.reasoningPreview || '')
  if (text === prevText && reasoning === prevReasoning) return row

  let segments = row.segments as MessageSegment[] | undefined
  if (text !== prevText) segments = patchTrailingSegment(segments, 'text', text)
  if (reasoning !== prevReasoning) {
    segments = patchTrailingSegment(segments, 'reasoning', reasoning)
  }

  return {
    ...row,
    text,
    reasoningPreview: reasoning || undefined,
    ...(segments ? { segments } : {}),
  }
}
