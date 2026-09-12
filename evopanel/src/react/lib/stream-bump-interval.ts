import type { StreamState } from '../chat-types.js'

/** Faster coalesce for live reasoning/thinking (SSE reasoning deltas). */
export const STREAM_REASONING_BUMP_INTERVAL_MS = 80

/** Default coalesce interval for stream UI bumps (SSE deltas / tools). */
export const STREAM_BUMP_INTERVAL_MS = 200

/** Slower paint when live turn payload is large (less main-thread churn). */
export const STREAM_BUMP_INTERVAL_MEDIUM_MS = 350
export const STREAM_BUMP_INTERVAL_LARGE_MS = 500

const STREAM_BUMP_SCORE_MEDIUM = 80_000
const STREAM_BUMP_SCORE_LARGE = 200_000

function segmentTextLen(segments: Array<{ kind: string; text?: string }> | undefined): number {
  if (!segments?.length) return 0
  let n = 0
  for (const seg of segments) {
    if (seg.kind === 'text' || seg.kind === 'reasoning') {
      n += String(seg.text || '').length
    }
  }
  return n
}

/** Rough live-turn weight for adaptive bump throttling (not exact byte size). */
export function estimateStreamBumpScore(stream: StreamState | null | undefined): number {
  if (!stream) return 0
  const openLen = String(stream.turn.openText || '').length
  const compactCount = stream.compactedParts?.length || 0
  const toolCount = stream.turn.tools?.length || 0
  const terminalCount = Object.keys(stream.terminalStreams || {}).length
  const subagentCount = Object.keys(stream.subagentTasks || {}).length

  let score = openLen
  score += compactCount * 4_000
  score += toolCount * 2_000
  score += terminalCount * 20_000
  score += subagentCount * 8_000

  if (openLen < 24_000 && compactCount <= 2) return score

  score = openLen
  score += segmentTextLen(stream.turn.timeline as Array<{ kind: string; text?: string }>)
  for (const part of stream.compactedParts || []) {
    score += String(part.text || '').length
    score += segmentTextLen(part.segments as Array<{ kind: string; text?: string }> | undefined)
    score += (part.tools?.length || 0) * 2_000
  }
  return score
}

export function resolveStreamBumpMinIntervalMs(stream: StreamState | null | undefined): number {
  const score = estimateStreamBumpScore(stream)
  if (score >= STREAM_BUMP_SCORE_LARGE) return STREAM_BUMP_INTERVAL_LARGE_MS
  if (score >= STREAM_BUMP_SCORE_MEDIUM) return STREAM_BUMP_INTERVAL_MEDIUM_MS
  return STREAM_BUMP_INTERVAL_MS
}
