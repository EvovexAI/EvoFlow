/**
 * Read cheap live text/reasoning from StreamState and publish to live-stream-store.
 * Does not run mergeCompactedParts / buildStreamDisplayRow.
 */
import type { StreamState } from '../chat-types.js'
import { projectAgUiToStreamTurnFields } from './agui-turn-reducer.js'
import { publishLiveStream, type LiveStreamSnapshot } from './live-stream-store.js'
import { projectStreamTurn } from './stream-turn-engine.js'

export function readLiveStreamLens(s: StreamState | null | undefined): {
  text: string
  reasoning: string
} {
  if (!s) return { text: '', reasoning: '' }
  if (s.aguiTurn) {
    const agui = projectAgUiToStreamTurnFields(s.aguiTurn)
    return {
      text: String(agui.openText || ''),
      reasoning: String(agui.reasoningPreview || ''),
    }
  }
  const proj = projectStreamTurn(s.turn)
  return {
    text: String(proj.text || ''),
    reasoning: String(proj.reasoningPreview || ''),
  }
}

export function publishLiveStreamFromState(
  sessionKey: string,
  s: StreamState | null | undefined,
  opts?: { streaming?: boolean },
): LiveStreamSnapshot | null {
  const sk = String(sessionKey || '').trim()
  if (!sk || !s) return null
  const lens = readLiveStreamLens(s)
  return publishLiveStream(sk, {
    text: lens.text,
    reasoning: lens.reasoning,
    streaming: opts?.streaming !== undefined ? opts.streaming : true,
  })
}
