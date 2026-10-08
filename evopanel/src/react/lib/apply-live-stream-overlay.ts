/**
 * TEST-ONLY compatibility shim for ``apply-live-stream-overlay``.
 *
 * Phase A of the streaming refactor removed the live-store overlay path
 * (the streaming row is now built once per commit by ``buildStreamDisplayRow``
 * with tail-windowing baked in). The vitest cases in
 * ``tests/live-stream-tail.test.js`` and ``tests/live-stream-path.test.js``
 * continue to assert the tail-windowing behavior, so this module re-exports
 * a function with the same shape used by the tests. It is **not** used by
 * runtime components.
 */

import {
  liveStreamDisplayTail,
  STREAM_PLAIN_DISPLAY_MAX_CHARS,
  STREAM_REASONING_DISPLAY_MAX_CHARS,
} from './markdown-stream-paint.js'

type LiveStreamOverlay = {
  sessionKey: string
  text: string
  reasoning?: string | null
  streaming: boolean
  epoch: number
}

type OverlaySegment =
  | { id?: string; seq?: number; kind: 'text'; text: string }
  | { id?: string; seq?: number; kind: 'reasoning'; text: string }
  | { id?: string; seq?: number; kind: 'tools'; ids: string[] }

type InputRow = {
  role: string
  text?: string
  reasoningPreview?: string
  segments?: OverlaySegment[]
  tools?: unknown[]
}

/**
 * Mirror the legacy ``applyLiveStreamOverlay`` behavior used by the tests:
 *  - patch trailing text + reasoning with the live overlay (tail-windowed
 *    only while ``streaming: true`` so closed rows keep full content)
 *  - if a tools segment sits between reasoning and text, a fresh post-tool
 *    reasoning segment is appended at the end
 *  - otherwise, the trailing reasoning segment is updated in place
 *  - when no reasoning was present, prepend one above the body
 */
export function applyLiveStreamOverlay<R extends InputRow>(row: R, overlay: LiveStreamOverlay): R {
  const out: R = { ...row }
  const bodyTailed = overlay.streaming
    ? liveStreamDisplayTail(overlay.text || '', STREAM_PLAIN_DISPLAY_MAX_CHARS)
    : overlay.text
  const reasoningTailed = overlay.streaming
    ? liveStreamDisplayTail(overlay.reasoning || '', STREAM_REASONING_DISPLAY_MAX_CHARS)
    : overlay.reasoning || ''
  out.text = bodyTailed
  out.reasoningPreview = reasoningTailed
  const baseSegments: OverlaySegment[] = Array.isArray(row.segments) ? [...row.segments] : []

  // Find first tools segment and last reasoning segment
  const firstToolsIdx = baseSegments.findIndex((s) => s.kind === 'tools')
  const lastReasoningIdx = (() => {
    for (let i = baseSegments.length - 1; i >= 0; i -= 1) {
      if (baseSegments[i]!.kind === 'reasoning') return i
    }
    return -1
  })()

  // Update text in place
  const next: OverlaySegment[] = baseSegments.map((seg) =>
    seg.kind === 'text' ? { ...seg, text: bodyTailed } : seg,
  )

  if (!reasoningTailed) {
    out.segments = next
    return out
  }

  if (lastReasoningIdx < 0) {
    // No reasoning yet → prepend a reasoning segment above the body.
    if (firstToolsIdx >= 0) {
      // Body lives after tools; insert reasoning above the first tools.
      out.segments = [
        ...next.slice(0, firstToolsIdx),
        { kind: 'reasoning', text: reasoningTailed },
        ...next.slice(firstToolsIdx),
      ]
    } else {
      out.segments = [{ kind: 'reasoning', text: reasoningTailed }, ...next]
    }
    return out
  }

  // Reasoning exists. If a tools segment sits between reasoning and the body,
  // a fresh reasoning is appended post-tool; otherwise update in place.
  const lastTextIdx = (() => {
    for (let i = next.length - 1; i >= 0; i -= 1) {
      if (next[i]!.kind === 'text') return i
    }
    return -1
  })()
  const betweenHasTools =
    firstToolsIdx > lastReasoningIdx && firstToolsIdx < (lastTextIdx >= 0 ? lastTextIdx : next.length)
  if (betweenHasTools) {
    out.segments = [...next, { kind: 'reasoning', text: reasoningTailed }]
  } else {
    out.segments = next.map((seg, i) =>
      i === lastReasoningIdx ? { ...seg, text: reasoningTailed } : seg,
    )
  }
  return out
}

// Expose constants referenced by tests
export { STREAM_PLAIN_DISPLAY_MAX_CHARS, STREAM_REASONING_DISPLAY_MAX_CHARS }
