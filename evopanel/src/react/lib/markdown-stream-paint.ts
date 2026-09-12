/** Beyond this size, plain-stream paint uses the slowest throttle tier. */
export const STREAM_MARKDOWN_MAX_CHARS = 12_000

/** Default min interval between streaming markdown paints. */
export const STREAM_PAINT_MIN_MS = 120

/** Slower plain paint when stream body is medium-large. */
export const STREAM_PAINT_MIN_MEDIUM_MS = 220

/** Plain-text streaming: no worker; throttle harder to cut DOM churn. */
export const STREAM_PLAIN_PAINT_MIN_MS = 400

/** Extra-slow paint once live body exceeds the display tail window. */
export const STREAM_PLAIN_PAINT_TAIL_MS = 520

/** Live reasoning/thinking: plain DOM, minimal paint interval. */
export const STREAM_REASONING_PAINT_MIN_MS = 48

/** Slower reasoning paint when chunk is very long. */
export const STREAM_REASONING_PAINT_MEDIUM_MS = 80

/** Min new chars before a catch-up reasoning paint after worker/plain was busy. */
export const STREAM_REASONING_REPAIN_MIN_DELTA_CHARS = 64

/** Completed bubbles above this size render via worker. */
export const FULL_MARKDOWN_WORKER_MIN_CHARS = 4096

const STREAM_PAINT_MEDIUM_CHARS = 6_000
const STREAM_REASONING_PAINT_MEDIUM_CHARS = 8_000

/**
 * Max plain text injected into DOM / overlay while streaming (tail only).
 * Unbounded live body is the main remaining jank after Phase 0 (verified at 5k–10k deltas).
 */
export const STREAM_PLAIN_DISPLAY_MAX_CHARS = 8_192

/** Reasoning fold tail while streaming (shorter than body). */
export const STREAM_REASONING_DISPLAY_MAX_CHARS = 6_144

const STREAM_PLAIN_TRUNC_HEAD = '…（前文已省略，仅显示最近部分）\n\n'

export function resolveStreamMarkdownPaintMinMs(charLen: number): number {
  return resolveStreamPlainPaintMinMs(charLen)
}

/** Plain-text body streaming paint interval (live turns skip worker markdown). */
export function resolveStreamPlainPaintMinMs(charLen: number): number {
  const n = Number(charLen) || 0
  if (n >= STREAM_PLAIN_DISPLAY_MAX_CHARS) return STREAM_PLAIN_PAINT_TAIL_MS
  if (n >= STREAM_PAINT_MEDIUM_CHARS) return STREAM_PAINT_MIN_MEDIUM_MS
  return STREAM_PAINT_MIN_MS
}

export function resolveReasoningStreamPaintMinMs(charLen: number): number {
  const n = Number(charLen) || 0
  if (n >= STREAM_REASONING_PAINT_MEDIUM_CHARS) return STREAM_REASONING_PAINT_MEDIUM_MS
  return STREAM_REASONING_PAINT_MIN_MS
}

/** Reasoning streams skip worker markdown parse for lower latency. */
export function shouldStreamReasoningAsPlain(_charLen: number): boolean {
  return true
}

/** Live assistant body always streams as plain text; markdown renders when isStreaming=false. */
export function shouldUseStreamingPlainMarkdown(_charLen: number): boolean {
  return true
}

/** Min new chars before a catch-up paint after worker was still busy. */
export const STREAM_PLAIN_REPAIN_MIN_DELTA_CHARS = 384

/** Keep only the live tail for paint/overlay. Store/history keep the full string. */
export function liveStreamDisplayTail(text: string, maxChars = STREAM_PLAIN_DISPLAY_MAX_CHARS): string {
  const raw = String(text || '')
  const cap = Math.max(64, Number(maxChars) || STREAM_PLAIN_DISPLAY_MAX_CHARS)
  if (raw.length <= cap) return raw
  const keep = Math.max(0, cap - STREAM_PLAIN_TRUNC_HEAD.length)
  return STREAM_PLAIN_TRUNC_HEAD + raw.slice(-keep)
}

export function streamingPlainDisplayText(text: string): string {
  return liveStreamDisplayTail(text, STREAM_PLAIN_DISPLAY_MAX_CHARS)
}

export function escapeHtmlPlain(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Plain streaming bubble HTML; caps visible tail to limit DOM size. */
export function buildStreamingPlainHtml(text: string): string {
  const raw = streamingPlainDisplayText(text)
  return `<pre class="msg-stream-plain">${escapeHtmlPlain(raw)}</pre>`
}
