// v5.8 修复：多轮 drain + ChatApp applyRowsUpdate 流程，merged row 应保留全部 tool id
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
import { mergeAssistantRowWithStreamRow } from '../src/react/lib/merge-assistant-stream-row.ts'
import { mergeToolsForPlanDetection } from '../src/lib/plan-pipeline.js'
import { buildAssistantBubbleDisplayPlan } from '../src/react/lib/message-row-display-plan.ts'

function drainLikeChatApp(S: any) {
  if (
    S.aguiTurn &&
    shouldReleaseAgUiBufferBeforeToolStart(S.aguiTurn, {
      type: 'TOOL_CALL_START',
      toolCallId: 'probe',
      toolCallName: 'probe',
    } as any)
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

describe('v5.8 真实 ChatApp applyRowsUpdate 流程：drain 后 row 应保留所有历史 tool id', () => {
  it('2 轮（8 tools + 旁白 + 2 tools + 旁白）：merged row 应含 10 个 tool id', () => {
    // 模拟你描述的场景：
    //   - 第 1 轮：旁白 + terminal+find + write + read + rg + replace + read + delete
    //     （简化版 8 tools）
    //   - drain → sealed → applyRowsUpdate 合并到 row
    //   - 第 2 轮：旁白 + write + replace
    // 期望：merged row 仍含所有 10 个 tool id
    const S = {
      turn: emptyStreamTurn(),
      aguiTurn: emptyAgUiTurnState('run-1', 't1'),
      compactedParts: [],
    }
    let assistantRow: any = null
    for (let n = 1; n <= 2; n++) {
      // 每轮先旁白
      const sid = `narration-${n}`
      S.aguiTurn = applyAgUiEvent(S.aguiTurn, { type: 'TEXT_MESSAGE_START', messageId: sid, role: 'assistant' })
      S.aguiTurn = applyAgUiEvent(S.aguiTurn, {
        type: 'TEXT_MESSAGE_CONTENT',
        messageId: sid,
        delta: n === 1 ? '工作区正常。开始做测试。' : '好，加量。这轮补三块。',
      })
      S.aguiTurn = applyAgUiEvent(S.aguiTurn, { type: 'TEXT_MESSAGE_END', messageId: sid })
      // 第 1 轮 8 tools，第 2 轮 2 tools
      const ids = n === 1
        ? ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']
        : ['t9', 't10']
      for (const id of ids) {
        S.aguiTurn = applyAgUiEvent(S.aguiTurn, {
          type: 'TOOL_CALL_START',
          toolCallId: id,
          toolCallName: 'terminal',
        } as any)
        S.aguiTurn = applyAgUiEvent(S.aguiTurn, {
          type: 'TOOL_CALL_ARGS',
          toolCallId: id,
          delta: '{}',
        } as any)
        S.aguiTurn = applyAgUiEvent(S.aguiTurn, {
          type: 'TOOL_CALL_END',
          toolCallId: id,
        } as any)
        S.aguiTurn = applyAgUiEvent(S.aguiTurn, {
          type: 'TOOL_CALL_RESULT',
          toolCallId: id,
          content: 'ok',
          messageId: `${id}-result`,
        } as any)
      }
      // 模拟 ChatApp drain
      const sealed = drainLikeChatApp(S)
      if (sealed) {
        // 镜像 ChatApp applyRowsUpdate (line 10165-10189)
        const patch = {
          role: 'assistant',
          text: String(sealed.text || ''),
          segments: sealed.segments,
          tools: sealed.tools,
          reasoningSegments: sealed.reasoningSegments,
          reasoningPreview: null,
          timestamp: Date.now(),
        }
        if (assistantRow) {
          const merged = mergeAssistantRowWithStreamRow({ ...assistantRow, incompleteStream: true }, patch)
          assistantRow = {
            ...merged,
            incompleteStream: true,
            tools: mergeToolsForPlanDetection(assistantRow.tools || [], sealed.tools || []),
            durationStr: undefined,
            tokenStr: undefined,
          }
        } else {
          assistantRow = { ...patch, incompleteStream: true }
        }
      }
    }
    expect(assistantRow, '应有 assistantRow').toBeTruthy()
    // 验证：merged row 工具应含 10 个 id
    const mergedIds = new Set<string>()
    for (const t of assistantRow.tools || []) {
      const id = (t as { id?: string }).id
      if (id) mergedIds.add(id)
    }
    for (const s of assistantRow.segments || []) {
      if (s.kind === 'tools') {
        for (const id of s.ids) mergedIds.add(String(id))
      }
    }
    for (let i = 1; i <= 10; i++) {
      expect(mergedIds.has(`t${i}`), `merged row 应含 t${i}（实际 ${JSON.stringify([...mergedIds])}）`).toBe(true)
    }
  })

  it('v5.8b plan 层验证：merged row 喂给 buildAssistantBubbleDisplayPlan 必须含 10 个 tool id', () => {
    // 模拟完整 ChatApp 流程 + plan 检测
    const S = {
      turn: emptyStreamTurn(),
      aguiTurn: emptyAgUiTurnState('run-1', 't1'),
      compactedParts: [],
    }
    let assistantRow: any = null
    for (let n = 1; n <= 2; n++) {
      const sid = `narration-${n}`
      S.aguiTurn = applyAgUiEvent(S.aguiTurn, { type: 'TEXT_MESSAGE_START', messageId: sid, role: 'assistant' })
      S.aguiTurn = applyAgUiEvent(S.aguiTurn, {
        type: 'TEXT_MESSAGE_CONTENT',
        messageId: sid,
        delta: n === 1 ? '工作区正常。' : '好，加量。',
      })
      S.aguiTurn = applyAgUiEvent(S.aguiTurn, { type: 'TEXT_MESSAGE_END', messageId: sid })
      const ids = n === 1 ? ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'] : ['t9', 't10']
      for (const id of ids) {
        S.aguiTurn = applyAgUiEvent(S.aguiTurn, {
          type: 'TOOL_CALL_START',
          toolCallId: id,
          toolCallName: 'terminal',
        } as any)
        S.aguiTurn = applyAgUiEvent(S.aguiTurn, {
          type: 'TOOL_CALL_ARGS',
          toolCallId: id,
          delta: '{}',
        } as any)
        S.aguiTurn = applyAgUiEvent(S.aguiTurn, { type: 'TOOL_CALL_END', toolCallId: id } as any)
        S.aguiTurn = applyAgUiEvent(S.aguiTurn, {
          type: 'TOOL_CALL_RESULT',
          toolCallId: id,
          content: 'ok',
          messageId: `${id}-result`,
        } as any)
      }
      const sealed = drainLikeChatApp(S)
      if (sealed) {
        const patch = {
          role: 'assistant',
          text: String(sealed.text || ''),
          segments: sealed.segments,
          tools: sealed.tools,
          reasoningSegments: sealed.reasoningSegments,
          reasoningPreview: null,
          timestamp: Date.now(),
        }
        if (assistantRow) {
          const merged = mergeAssistantRowWithStreamRow({ ...assistantRow, incompleteStream: true }, patch)
          assistantRow = {
            ...merged,
            incompleteStream: true,
            tools: mergeToolsForPlanDetection(assistantRow.tools || [], sealed.tools || []),
            durationStr: undefined,
            tokenStr: undefined,
          }
        } else {
          assistantRow = { ...patch, incompleteStream: true }
        }
      }
    }
    expect(assistantRow, '应有 assistantRow').toBeTruthy()
    // 喂给 plan 检测 tool id 是否全部进 chunk pieces
    const planInput = {
      row: assistantRow,
      displaySegments: assistantRow.segments || [],
      tools: assistantRow.tools || [],
      rawText: assistantRow.text || '',
      text: assistantRow.text || '',
      textTrimmed: !!String(assistantRow.text || '').trim(),
      reasoningPreview: assistantRow.reasoningPreview || '',
      reasoningSegments: assistantRow.reasoningSegments || [],
      isStreaming: false,
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
    const plan = buildAssistantBubbleDisplayPlan(planInput as any)
    const planToolIds = new Set<string>()
    for (const slot of plan.slots) {
      if (slot.kind === 'chunk' && slot.chunk.kind === 'activity') {
        for (const piece of slot.chunk.pieces) {
          if (piece.kind === 'tools') {
            for (const id of piece.ids) planToolIds.add(String(id))
          }
        }
      }
      if (slot.kind === 'tools-standalone') {
        for (const id of slot.ids) planToolIds.add(String(id))
      }
      if (slot.kind === 'orphan-tools') {
        for (const t of slot.tools || []) {
          const id = (t as { id?: string }).id
          if (id) planToolIds.add(id)
        }
      }
    }
    for (let i = 1; i <= 10; i++) {
      expect(planToolIds.has(`t${i}`), `plan 应含 t${i}（实际 ${JSON.stringify([...planToolIds])}）`).toBe(true)
    }
  })

    it('v5.8c 完整 chunks 形状：模拟你的回合 (前 8 tools + 旁白 + 2 tools + 旁白)', async () => {
    // 1. 走完整 buildStreamDisplayRow 路径，build row
    // 2. 把 row 喂给 buildAssistantBubbleDisplayPlan
    // 3. 检查 chunk 形状：应该有 1 个 activity chunk，含全部 10 tools
    const { buildStreamDisplayRow } = await import('../src/react/lib/build-stream-display-row.ts')
    const S = {
      turn: emptyStreamTurn(),
      aguiTurn: emptyAgUiTurnState('run-1', 't1'),
      compactedParts: [],
    }
    let assistantRow: any = null
    for (let n = 1; n <= 2; n++) {
      const sid = `narration-${n}`
      S.aguiTurn = applyAgUiEvent(S.aguiTurn, { type: 'TEXT_MESSAGE_START', messageId: sid, role: 'assistant' })
      S.aguiTurn = applyAgUiEvent(S.aguiTurn, {
        type: 'TEXT_MESSAGE_CONTENT',
        messageId: sid,
        delta: n === 1 ? '工作区正常。开始做测试。' : '好，加量。这轮补三块。',
      })
      S.aguiTurn = applyAgUiEvent(S.aguiTurn, { type: 'TEXT_MESSAGE_END', messageId: sid })
      const ids = n === 1 ? ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'] : ['t9', 't10']
      for (const id of ids) {
        S.aguiTurn = applyAgUiEvent(S.aguiTurn, {
          type: 'TOOL_CALL_START',
          toolCallId: id,
          toolCallName: 'terminal',
        } as any)
        S.aguiTurn = applyAgUiEvent(S.aguiTurn, {
          type: 'TOOL_CALL_ARGS',
          toolCallId: id,
          delta: '{}',
        } as any)
        S.aguiTurn = applyAgUiEvent(S.aguiTurn, { type: 'TOOL_CALL_END', toolCallId: id } as any)
        S.aguiTurn = applyAgUiEvent(S.aguiTurn, {
          type: 'TOOL_CALL_RESULT',
          toolCallId: id,
          content: 'ok',
          messageId: `${id}-result`,
        } as any)
      }
      const sealed = drainLikeChatApp(S)
      if (sealed) {
        const patch = {
          role: 'assistant',
          text: String(sealed.text || ''),
          segments: sealed.segments,
          tools: sealed.tools,
          reasoningSegments: sealed.reasoningSegments,
          reasoningPreview: null,
          timestamp: Date.now(),
        }
        if (assistantRow) {
          const merged = mergeAssistantRowWithStreamRow({ ...assistantRow, incompleteStream: true }, patch)
          assistantRow = {
            ...merged,
            incompleteStream: true,
            tools: mergeToolsForPlanDetection(assistantRow.tools || [], sealed.tools || []),
            durationStr: undefined,
            tokenStr: undefined,
          }
        } else {
          assistantRow = { ...patch, incompleteStream: true }
        }
      }
    }
    expect(assistantRow, '应有 assistantRow').toBeTruthy()
    // buildStreamDisplayRow 输出
    const built = buildStreamDisplayRow(S, '', false, false, { body: '', reasoning: '', toolIds: [] } as any, '')
    expect(built, 'buildStreamDisplayRow 应返回 row').toBeTruthy()
    // 喂 plan
    const planInput = {
      row: built,
      displaySegments: built.segments || [],
      tools: built.tools || [],
      rawText: built.text || '',
      text: built.text || '',
      textTrimmed: !!String(built.text || '').trim(),
      reasoningPreview: built.reasoningPreview || '',
      reasoningSegments: built.reasoningSegments || [],
      isStreaming: false,
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
    const plan = buildAssistantBubbleDisplayPlan(planInput as any)
    // 打印 plan slots 概要
    const summary: string[] = []
    for (const slot of plan.slots) {
      if (slot.kind === 'chunk' && slot.chunk.kind === 'activity') {
        const tools: string[] = []
        const textSnips: string[] = []
        const reasoningSnips: string[] = []
        for (const p of slot.chunk.pieces) {
          if (p.kind === 'tools') {
            for (const id of p.ids) tools.push(String(id))
          } else if (p.kind === 'text') {
            textSnips.push(String(p.text || '').slice(0, 30))
          } else if (p.kind === 'reasoning') {
            reasoningSnips.push(String(p.text || '').slice(0, 30))
          }
        }
        summary.push(`activity(tools=[${tools.join(',')}] text=[${textSnips.join('|')}] reasoning=[${reasoningSnips.join('|')}])`)
      } else if (slot.kind === 'chunk' && slot.chunk.kind === 'text') {
        summary.push(`text="${String(slot.chunk.text || '').slice(0, 50)}"`)
      } else if (slot.kind === 'plain-body') {
        summary.push(`plain-body="${String((slot as any).text || '').slice(0, 50)}"`)
      } else {
        summary.push(`${slot.kind}`)
      }
    }
    // 验证：所有 10 tool id 必须出现在 plan 的 activity chunk 里
    const planToolIds = new Set<string>()
    for (const slot of plan.slots) {
      if (slot.kind === 'chunk' && slot.chunk.kind === 'activity') {
        for (const piece of slot.chunk.pieces) {
          if (piece.kind === 'tools') {
            for (const id of piece.ids) planToolIds.add(String(id))
          }
        }
      }
      if (slot.kind === 'tools-standalone') {
        for (const id of slot.ids) planToolIds.add(String(id))
      }
      if (slot.kind === 'orphan-tools') {
        for (const t of slot.tools || []) {
          const id = (t as { id?: string }).id
          if (id) planToolIds.add(id)
        }
      }
    }
    for (let i = 1; i <= 10; i++) {
      const has = planToolIds.has(`t${i}`)
      if (!has) {
        throw new Error(
          `[v5.8c] plan 缺 t${i}\n` +
          `  built.segments=${JSON.stringify((built.segments || []).map((s: any) => s.kind === 'tools' ? `tools(${s.ids.join(',')})` : `<${s.kind}>`))}\n` +
          `  built.tools count=${(built.tools || []).length}\n` +
          `  S.compactedParts.length=${S.compactedParts?.length || 0}\n` +
          (S.compactedParts || []).map((p: any, i: number) =>
            `  compacted[${i}].segments=${JSON.stringify((p.segments || []).map((s: any) => s.kind === 'tools' ? `tools(${s.ids.join(',')})` : `<${s.kind}>`))}`
          ).join('\n') + '\n' +
          `  plan.slots.summary=${summary.join(' | ')}`,
        )
      }
      expect(has, `plan 应含 t${i}`).toBe(true)
    }
  })
})
