import { describe, it, expect } from 'vitest'
import {
  applyAgUiEvent,
  emptyAgUiTurnState,
  shouldReleaseAgUiBufferBeforeToolStart,
  finalizeGhostRunningToolsBeforeNewRound,
  drainAgUiCompletedRound,
  syncStreamTurnFromAgUi,
} from '../src/react/lib/agui-turn-reducer.ts'
import { emptyStreamTurn } from '../src/react/lib/stream-turn-engine.ts'
import { buildStreamDisplayRow } from '../src/react/lib/build-stream-display-row.ts'
import { buildAssistantBubbleDisplayPlan } from '../src/react/lib/message-row-display-plan.ts'
import { mergeAssistantRowWithStreamRow } from '../src/react/lib/merge-assistant-stream-row.ts'

/**
 * 复现 v2：真实 wire 形态（无 blockId/seq，与 tests/fixtures/agui/*.jsonl 一致）。
 * 驱动：applyAgUiEvent → ChatApp drain → buildStreamDisplayRow（真实函数）
 * → buildAssistantBubbleDisplayPlan，逐轮检查工具存活。
 */

const NO_STRIP = { body: '', reasoning: '', toolIds: [] }

function driveRound(state, n) {
  const k = n
  // 轮间旁白（第 2 轮起）
  if (k > 1) {
    const sid = `narration-${k}`
    state = applyAgUiEvent(state, { type: 'TEXT_MESSAGE_START', messageId: sid, role: 'assistant' })
    state = applyAgUiEvent(state, { type: 'TEXT_MESSAGE_CONTENT', messageId: sid, delta: `第${k}轮开始。` })
    state = applyAgUiEvent(state, { type: 'TEXT_MESSAGE_END', messageId: sid })
  }
  const rid = `reasoning-${k}`
  state = applyAgUiEvent(state, { type: 'REASONING_MESSAGE_START', messageId: rid, role: 'reasoning' })
  state = applyAgUiEvent(state, { type: 'REASONING_MESSAGE_CONTENT', messageId: rid, delta: `第${k}轮思考。` })
  state = applyAgUiEvent(state, { type: 'REASONING_MESSAGE_END', messageId: rid })
  state = applyAgUiEvent(state, { type: 'REASONING_END', messageId: rid })
  const toolCallId = `call-${k}`
  state = applyAgUiEvent(state, { type: 'TOOL_CALL_START', toolCallId, toolCallName: 'terminal' })
  state = applyAgUiEvent(state, { type: 'TOOL_CALL_ARGS', toolCallId, delta: '{"command":"echo"}' })
  state = applyAgUiEvent(state, { type: 'TOOL_CALL_END', toolCallId })
  state = applyAgUiEvent(state, { type: 'TOOL_CALL_RESULT', toolCallId, content: `result ${k}`, messageId: `${toolCallId}-result` })
  return state
}

function drainLikeChatApp(S) {
  if (
    S.aguiTurn &&
    shouldReleaseAgUiBufferBeforeToolStart(S.aguiTurn, {
      type: 'TOOL_CALL_START', toolCallId: 'probe', toolCallName: 'probe',
    })
  ) {
    finalizeGhostRunningToolsBeforeNewRound(S.aguiTurn)
    const { sealed, fresh } = drainAgUiCompletedRound(S.aguiTurn)
    if (sealed) {
      if (!S.compactedParts) S.compactedParts = []
      S.compactedParts.push(sealed)
      S.aguiTurn = fresh
      S.turn = syncStreamTurnFromAgUi(S.turn, S.aguiTurn)
      return sealed
    }
  }
  return null
}

function planToolIdsFor(row) {
  const input = {
    row,
    displaySegments: row.segments || [],
    tools: row.tools || [],
    rawText: row.text || '',
    text: row.text || '',
    textTrimmed: !!String(row.text || '').trim(),
    reasoningPreview: row.reasoningPreview || '',
    reasoningSegments: row.reasoningSegments || [],
    isStreaming: row.role === '_stream',
    interactiveToolApproval: false,
    suppressPlanExecPromptNoise: false,
    hasToolsInTurnEarly: true,
    systemActivityLabel: '',
    streamThinkingLabel: '',
    legacyHasTools: false,
    legacyShowBody: true,
    plainBodyRaw: '',
    plainShowThinkingCursor: false,
  }
  const plan = buildAssistantBubbleDisplayPlan(input)
  const ids = []
  const pieces = []
  for (const slot of plan.slots) {
    if (slot.kind === 'chunk' && slot.chunk.kind === 'activity') {
      for (const piece of slot.chunk.pieces) {
        pieces.push(`${piece.kind}${piece.kind === 'tools' ? `(${piece.ids.join(',')})` : ''}`)
        if (piece.kind === 'tools') ids.push(...piece.ids)
      }
    }
    if (slot.kind === 'tools-standalone') ids.push(...slot.ids)
    if (slot.kind === 'orphan-tools') ids.push(...(slot.tools || []).map((t) => t.id))
  }
  return { ids, pieces }
}

describe('真实 wire 形态（无 blockId/seq）：多轮工具不应消失', () => {
  it('display plan 逐轮保留全部工具（真实 buildStreamDisplayRow）', () => {
    const S = {
      turn: emptyStreamTurn(),
      aguiTurn: emptyAgUiTurnState('run-1', 't1'),
      compactedParts: [],
    }
    let assistantRow = null
    for (let n = 1; n <= 4; n++) {
      S.aguiTurn = driveRound(S.aguiTurn, n)
      if (n < 4) {
        const sealed = drainLikeChatApp(S)
        if (sealed) {
          // 镜像 ChatApp drain patch：并入 incomplete assistant 行
          const patch = {
            role: 'assistant',
            text: String(sealed.text || ''),
            segments: sealed.segments,
            tools: sealed.tools,
            reasoningSegments: sealed.reasoningSegments,
            reasoningPreview: null,
            timestamp: Date.now(),
          }
          assistantRow = assistantRow
            ? { ...mergeAssistantRowWithStreamRow({ ...assistantRow, incompleteStream: true }, patch), incompleteStream: true }
            : { ...patch, incompleteStream: true }
        }
      }
      // 每条事件后 buildStreamDisplayRow 都会被调用；这里在每轮结束调用一次
      const built = buildStreamDisplayRow(S, '', false, true, NO_STRIP, '')
      expect(built, '流式行应可构建').toBeTruthy()
      const streamPlan = planToolIdsFor(built)
      const expected = Array.from({ length: n }, (_, i) => `call-${i + 1}`)
      for (const id of expected) {
        expect(
          streamPlan.ids,
          `round ${n}: 流式行 display plan 应含 ${id}（实际 ${JSON.stringify(streamPlan)}）`,
        ).toContain(id)
      }
      // MessageVirtualList continuation 合并后的行
      const displayRow = assistantRow
        ? mergeAssistantRowWithStreamRow(assistantRow, built)
        : built
      const mergedPlan = planToolIdsFor({ ...displayRow, role: '_stream' })
      for (const id of expected) {
        expect(
          mergedPlan.ids,
          `round ${n}: 合并行 display plan 应含 ${id}（实际 ${JSON.stringify(mergedPlan)}）`,
        ).toContain(id)
      }
    }
  })
})
