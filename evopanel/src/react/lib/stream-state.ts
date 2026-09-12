import type { StreamState } from '../chat-types.js'
import { cloneTerminalStreamsMap } from '../terminal-stream-merge.js'
import {
  cloneStreamTurn,
  emptyStreamTurn,
  // @ts-ignore
  projectStreamTurn,
  projectStreamTurnWithCompacted,
  streamTurnHasVisibleContent,
  streamTurnHasCompactedContent,
} from './stream-turn-engine.js'
import { cloneAgUiTurnState, projectAgUiToStreamTurnFields } from './agui-turn-reducer.js'

export function emptyStream(): StreamState {
  return {
    runId: null,
    turn: emptyStreamTurn(),
    aguiTurn: null,
    compactedParts: [],
    startTs: null,
    subagentTasks: {},
    terminalStreams: {},
  }
}

export function cloneStreamState(S: StreamState): StreamState {
  return {
    runId: S.runId,
    turn: cloneStreamTurn(S.turn),
    aguiTurn: S.aguiTurn ? cloneAgUiTurnState(S.aguiTurn) : null,
    compactedParts: (S.compactedParts || []).map((p) => ({
      ...p,
      tools: [...(p.tools || [])],
      reasoningSegments: [...(p.reasoningSegments || [])],
      segments: p.segments ? [...p.segments] : undefined,
      images: [...(p.images || [])],
      videos: [...(p.videos || [])],
      audios: [...(p.audios || [])],
      files: [...(p.files || [])],
    })),
    startTs: S.startTs,
    subagentTasks: S.subagentTasks ? { ...S.subagentTasks } : {},
    terminalStreams: cloneTerminalStreamsMap(S.terminalStreams) || {},
  }
}

export function streamProject(S: StreamState) {
  return projectStreamTurnWithCompacted(S.turn, S.compactedParts)
}

export function streamRefHasVisibleContent(S: StreamState): boolean {
  if (S.aguiTurn) {
    const agui = S.aguiTurn
    if (agui.compatSegments.length > 0 || (agui.compatTools?.length ?? 0) > 0) return true
    if (agui.toolCalls.size > 0) return true
    for (const m of agui.messages.values()) {
      if (String(m.content || '').trim()) return true
    }
    if (agui.order.length > 0) {
      const proj = projectAgUiToStreamTurnFields(agui)
      if (
        String(proj.reasoningPreview || '').trim() ||
        String(proj.openText || '').trim() ||
        proj.timeline.length ||
        proj.tools.length
      ) {
        return true
      }
    }
  }
  return (
    streamTurnHasVisibleContent(S.turn) ||
    streamTurnHasCompactedContent(S.compactedParts) ||
    Object.keys(S.subagentTasks || {}).length > 0 ||
    Object.keys(S.terminalStreams || {}).length > 0
  )
}

/** AG-UI wire is authoritative for live turn projection; legacy stream_turn/delta must not double-apply. */
export function isAgUiStreamActive(S: StreamState | null | undefined): boolean {
  return !!(S && S.aguiTurn)
}