/**
 * Coalesce high-frequency chat text/reasoning pieces before dispatch to ChatApp.
 * One rAF slice merges burst SSE deltas into a single chat event per stream.
 */

const buffers = new Map()

function bufferKey(sessionKey, runId) {
  return `${String(sessionKey || '').trim()}:${String(runId || '').trim()}`
}

function getBuffer(key, runId) {
  const id = bufferKey(key, runId)
  let buf = buffers.get(id)
  if (!buf) {
    buf = {
      textPieces: [],
      reasoningPreview: '',
      reasoningBlock: null,
      lastTextOpts: null,
      rafId: 0,
    }
    buffers.set(id, buf)
  }
  return buf
}

function cancelScheduled(buf) {
  if (!buf?.rafId) return
  try {
    cancelAnimationFrame(buf.rafId)
  } catch {
    /* ignore */
  }
  buf.rafId = 0
}

/**
 * @param {(payload: {
 *   sessionKey: string
 *   runId: string
 *   piece: string
 *   opts?: Record<string, unknown>
 *   reasoningPreview?: string
 *   reasoningBlock?: Record<string, unknown> | null
 * }) => void} emitNow
 */
export function flushChatPieceCoalesce(sessionKey, runId, emitNow) {
  const id = bufferKey(sessionKey, runId)
  const buf = buffers.get(id)
  if (!buf) return
  cancelScheduled(buf)
  const key = String(sessionKey || '').trim()
  const rid = String(runId || '').trim()
  if (!key || !rid) {
    buffers.delete(id)
    return
  }
  if (buf.textPieces.length) {
    const merged = buf.textPieces.join('')
    buf.textPieces = []
    const opts = buf.lastTextOpts || {}
    buf.lastTextOpts = null
    emitNow({ sessionKey: key, runId: rid, piece: merged, opts })
  }
  if (buf.reasoningPreview) {
    const preview = buf.reasoningPreview
    const block = buf.reasoningBlock
    buf.reasoningPreview = ''
    buf.reasoningBlock = null
    emitNow({
      sessionKey: key,
      runId: rid,
      piece: '',
      reasoningPreview: preview,
      reasoningBlock: block,
    })
  }
  if (!buf.textPieces.length && !buf.reasoningPreview) {
    buffers.delete(id)
  }
}

export function scheduleChatTextPieceCoalesce(sessionKey, runId, piece, opts, emitNow) {
  const key = String(sessionKey || '').trim()
  const rid = String(runId || '').trim()
  if (!key || !rid) return
  const p = String(piece || '')
  if (!p) return
  const buf = getBuffer(key, rid)
  buf.textPieces.push(p)
  buf.lastTextOpts = opts && typeof opts === 'object' ? opts : null
  if (buf.rafId) return
  buf.rafId = requestAnimationFrame(() => {
    buf.rafId = 0
    flushChatPieceCoalesce(key, rid, emitNow)
  })
}

export function scheduleChatReasoningCoalesce(
  sessionKey,
  runId,
  reasoningPreview,
  reasoningBlock,
  emitNow,
) {
  const key = String(sessionKey || '').trim()
  const rid = String(runId || '').trim()
  if (!key || !rid) return
  const preview = String(reasoningPreview || '').trim()
  if (!preview) return
  const buf = getBuffer(key, rid)
  buf.reasoningPreview = preview
  buf.reasoningBlock = reasoningBlock && typeof reasoningBlock === 'object' ? reasoningBlock : null
  if (buf.rafId) return
  buf.rafId = requestAnimationFrame(() => {
    buf.rafId = 0
    flushChatPieceCoalesce(key, rid, emitNow)
  })
}

export function disposeChatPieceCoalesce(sessionKey, runId, emitNow) {
  flushChatPieceCoalesce(sessionKey, runId, emitNow)
}
