import type { DisplayRow } from '../../chat-types.js'
import type { StreamTurnState } from '../stream-turn-engine.js'
import {
  collectToolCallIdsFromTurn,
  finalizeStreamTurn,
  streamTurnHasVisibleContent,
} from '../stream-turn-engine.js'
import {
  getSessionRuntime,
  rowsAlreadyStopSealedForTurn,
  rtAddStaleToolCallIds,
  rtAddStoppedRun,
  updateSessionRuntimeRows,
  type SessionRuntime,
} from '../session-runtime-store.js'
import { commitPriorTurnStripFromStreamTurn } from '../turn-text-isolation.js'
import { STOP_SEALED_SYSTEM_TEXT } from './commands.js'

function buildPartialStreamAssistantRow(turn: StreamTurnState, runId?: string | null): DisplayRow {
  const fin = finalizeStreamTurn(turn, '')
  return {
    role: 'assistant',
    text: fin.text,
    segments: fin.segments,
    reasoningSegments: fin.reasoningSegments,
    reasoningPreview: fin.reasoningPreview,
    tools: [...fin.tools],
    images: [...fin.images],
    videos: [...fin.videos],
    audios: [...fin.audios],
    files: [...fin.files],
    timestamp: Date.now(),
    incompleteStream: true,
    ...(runId ? { runId: String(runId) } : {}),
  }
}

function sealStoppedStreamTurn(
  rt: SessionRuntime,
  turn: StreamTurnState,
  runId: string | null | undefined,
): void {
  rtAddStaleToolCallIds(rt, collectToolCallIdsFromTurn(turn))
  rtAddStoppedRun(rt, runId)
}

/** 停止时封存 partial assistant + system「生成已停止」行；返回是否写入了新行 */
export function sealSessionPartialTurnOnStop(
  sessionKey: string,
  opts: { stopRunId?: string | null } = {},
): boolean {
  const sk = String(sessionKey || '').trim()
  if (!sk) return false
  const rt = getSessionRuntime(sk)
  const curRows = rt.rows
  if (!streamTurnHasVisibleContent(rt.stream.turn) || rowsAlreadyStopSealedForTurn(curRows)) {
    const stoppedRun = opts.stopRunId ?? rt.activeChatRunId ?? rt.stream.runId
    if (stoppedRun) rtAddStoppedRun(rt, stoppedRun)
    return false
  }
  const stoppedRun = opts.stopRunId ?? rt.activeChatRunId ?? rt.stream.runId
  commitPriorTurnStripFromStreamTurn(rt, rt.stream.turn)
  sealStoppedStreamTurn(rt, rt.stream.turn, stoppedRun)
  updateSessionRuntimeRows(sk, (r) => [
    ...r,
    {
      ...buildPartialStreamAssistantRow(rt.stream.turn, stoppedRun),
      incompleteStream: undefined,
    },
    { role: 'system' as const, text: STOP_SEALED_SYSTEM_TEXT, timestamp: Date.now() },
  ])
  return true
}
