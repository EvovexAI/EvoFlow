import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventSchemas } from '@ag-ui/core'
import {
  applyAgUiEvent,
  emptyAgUiTurnState,
  projectAgUiToStreamTurnFields,
  replayAgUiEvents,
} from '../src/react/lib/agui-turn-reducer.ts'
import { toolToChip, buildAssistantDomView } from '../src/react/lib/assistant-dom-view.ts'
import { groupSegmentsForExploringDisplay } from '../src/react/lib/exploring-activity-group.ts'
import { buildAssistantBubbleDisplayPlan } from '../src/react/lib/message-row-display-plan.ts'

/**
 * 真实流式回放：run-133609527d1f（22:21 dev 跑，8 工具 + final body）
 * v5.9 dom-view 验证 — 用真实事件序列做 fixture，vi.useFakeTimers 推进时间，
 * 校验：
 *   1. 工具耗时（elapsed）非 0
 *   2. openText 在工具阶段空、最终阶段累积完整 body
 *   3. 工具阶段 dom-view body 不含 plain-body
 */
const __dir = dirname(fileURLToPath(import.meta.url))

function loadRealRunEvents(name) {
  const raw = readFileSync(join(__dir, 'fixtures', 'agui', name), 'utf8')
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('========'))
    .map((l) => EventSchemas.parse(JSON.parse(l)))
}

describe('真实流式回放：run-133609527d1f (8 工具 + body)', () => {
  let realNow
  beforeEach(() => {
    realNow = Date.now
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-09T22:21:47.000Z'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    Date.now = realNow
    vi.restoreAllMocks()
  })

  it('每个工具 _uiStartedAtMs / _uiEndedAtMs 真实差值 > 0（耗时非 0 秒）', () => {
    const events = loadRealRunEvents('run-133609527d1f-sse.jsonl')
    // 真实 run 8 工具跨约 22 秒；fake timer 每事件推进 50ms 模拟流式节奏
    let s = emptyAgUiTurnState('run-133609527d1f', 'c98622f1-6149-4abc-b0b6-dd00e94657e9')
    const toolCallOrder = []
    for (const ev of events) {
      vi.setSystemTime(new Date(Date.now() + 50))
      s = applyAgUiEvent(s, ev)
      if (ev.type === 'TOOL_CALL_START') toolCallOrder.push(ev.toolCallId)
      if (ev.type === 'TOOL_CALL_RESULT' && s.toolCalls.get(ev.toolCallId)?._uiEndedAtMs) {
        const tc = s.toolCalls.get(ev.toolCallId)
        const start = tc._uiStartedAtMs
        const end = tc._uiEndedAtMs
        expect(end, `${ev.toolCallId} endedAtMs must be set`).toBeGreaterThan(0)
        expect(start, `${ev.toolCallId} startedAtMs must be set`).toBeGreaterThan(0)
        expect(end - start, `${ev.toolCallId} elapsed must be > 0`).toBeGreaterThan(0)
      }
    }
    // 期望 7 个工具都跑完（fixture 实际 7 个）
    const doneTools = toolCallOrder.filter((id) => s.toolCalls.get(id)?._uiEndedAtMs)
    expect(doneTools.length, '期望 ≥ 7 个工具完成').toBeGreaterThanOrEqual(7)
  })

  it('工具阶段 openText 为空；TEXT_MESSAGE_CONTENT 累积到 compatSegments.text 段', () => {
    const events = loadRealRunEvents('run-133609527d1f-sse.jsonl')
    let s = emptyAgUiTurnState('run-133609527d1f', 'c98622f1-6149-4abc-b0b6-dd00e94657e9')
    let bodyStartIdx = -1  // 第一个 TEXT_MESSAGE_CONTENT idx
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]
      vi.setSystemTime(new Date(Date.now() + 30))
      s = applyAgUiEvent(s, ev)
      if (ev.type === 'TEXT_MESSAGE_CONTENT' && bodyStartIdx < 0) bodyStartIdx = i
    }
    // 工具阶段：取最后一个 TEXT_MESSAGE_CONTENT 之前的 openText，应为空
    s = emptyAgUiTurnState('run-133609527d1f', 'c98622f1-6149-4abc-b0b6-dd00e94657e9')
    let toolPhaseMax = ''
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]
      vi.setSystemTime(new Date(Date.now() + 30))
      s = applyAgUiEvent(s, ev)
      if (bodyStartIdx >= 0 && i >= bodyStartIdx) break  // 在正文开始时停止
      const proj = projectAgUiToStreamTurnFields(s)
      toolPhaseMax = proj.openText
    }
    expect(toolPhaseMax, '工具阶段（TEXT_MESSAGE_CONTENT 之前）openText 应为空').toBe('')

    // 完整 replay：期望 compatSegments 至少含 1 个 text 段，长度 > 100
    s = emptyAgUiTurnState('run-133609527d1f', 'c98622f1-6149-4abc-b0b6-dd00e94657e9')
    for (const ev of events) {
      vi.setSystemTime(new Date(Date.now() + 30))
      s = applyAgUiEvent(s, ev)
    }
    const finalProj = projectAgUiToStreamTurnFields(s)
    const textSeg = finalProj.timeline.find((seg) => seg.kind === 'text')
    expect(textSeg, '期望 final compatSegments 含 text 段').toBeTruthy()
    expect(String(textSeg?.text || '').length, 'text 段应 > 100 字符').toBeGreaterThan(100)
    expect(String(textSeg?.text || '')).toMatch(/本次|工具|write/)
  })

  it('工具投影到 row.tools 后 _uiStartedAtMs 仍保留（_ui 字段不被 strip）', () => {
    const events = loadRealRunEvents('run-133609527d1f-sse.jsonl')
    let s = emptyAgUiTurnState('run-133609527d1f', 'c98622f1-6149-4abc-b0b6-dd00e94657e9')
    for (const ev of events) {
      vi.setSystemTime(new Date(Date.now() + 30))
      s = applyAgUiEvent(s, ev)
    }
    expect(s.compatTools.length, 'state.compatTools 应含 7 个工具').toBe(7)
    // v5.9 修：toolEntryFromAgUi 必须把 _uiStartedAtMs / _uiEndedAtMs 复制到 entry
    let toolEntryWithElapsed = 0
    const noElapsedDetails = []
    for (const t of s.compatTools) {
      if (t && (t._uiStartedAtMs || t.startedAtMs)) {
        const started = t._uiStartedAtMs ?? t.startedAtMs
        const ended = t._uiEndedAtMs ?? t.endedAtMs
        if (started && ended) {
          // toolToChip 把 started/ended 渲染成 elapsed
          const chip = toolToChip(t)
          if (chip.elapsed === '0秒') {
            noElapsedDetails.push({
              id: t.id,
              started,
              ended,
              diff: ended - started,
              status: t.status,
              _uiStartedAtMs: t._uiStartedAtMs,
              _uiEndedAtMs: t._uiEndedAtMs,
              startedAtMs: t.startedAtMs,
              endedAtMs: t.endedAtMs,
            })
            continue
          }
          expect(chip.elapsed, `${t.id} chip.elapsed must be defined`).toBeDefined()
          expect(chip.elapsed, `${t.id} chip.elapsed must not be 0秒 (got ${chip.elapsed})`).not.toBe('0秒')
          toolEntryWithElapsed++
        }
      }
    }
    if (noElapsedDetails.length) {
      console.warn('NO-ELAPSED details:', JSON.stringify(noElapsedDetails, null, 2))
    }
    expect(noElapsedDetails, '所有 tool 都应有非 0 elapsed').toEqual([])
    expect(toolEntryWithElapsed, '期望 ≥ 7 个 tool entry 有非 0 elapsed').toBeGreaterThanOrEqual(7)
  })

  it('流式中间状态：displaySegments 1 个 tools 段含 7 id，row.tools 全 7 工具可解析', () => {
    // 复现用户反馈"显示 4-5 个工具后又显示工具，前面的工具看不到"
    // 根因假设：groupSegmentsForExploringDisplay 在 tools segment 上做 findToolByCallId，
    //   如果 row.tools 数组里没那个 tool，streaming 期直接 continue 跳过。
    //   → 7 个工具只显示 2 个（其余 id 在 row.tools 里没找到）。
    const events = loadRealRunEvents('run-133609527d1f-sse.jsonl')
    let s = emptyAgUiTurnState('run-133609527d1f', 'c98622f1-6149-4abc-b0b6-dd00e94657e9')
    let resultCount = 0
    let startCount = 0
    let stop = false
    for (const ev of events) {
      if (stop) break
      vi.setSystemTime(new Date(Date.now() + 30))
      s = applyAgUiEvent(s, ev)
      if (ev.type === 'TOOL_CALL_START') startCount++
      if (ev.type === 'TOOL_CALL_RESULT') {
        resultCount++
        if (resultCount >= 4 && startCount >= 5) stop = true
      }
    }
    expect(s.compatTools.length, `state.compatTools 应 ≥ 5. 实际 = ${s.compatTools.length}; toolCalls.size = ${s.toolCalls.size}; order = ${s.order.length}`).toBeGreaterThanOrEqual(5)
    const toolsSeg = s.compatSegments.find((seg) => seg.kind === 'tools')
    expect(toolsSeg, 'compatSegments 应含 1 个 tools 段').toBeTruthy()
    const segIds = toolsSeg?.kind === 'tools' ? toolsSeg.ids : []
    expect(segIds.length, 'tools 段 ids 应 ≥ 5').toBeGreaterThanOrEqual(5)
    const allToolIdsInRow = new Set(s.compatTools.map((t) => String(t.id || t.tool_call_id || '')))
    const unresolved = segIds.filter((id) => !allToolIdsInRow.has(id))
    expect(unresolved, 'row.tools 应能 resolve 所有 segIds').toEqual([])

    // v5.9 复刻：走 groupSegmentsForExploringDisplay → toolsForActivityPieces 路径
    // 模拟 dom-view 投影，验证 5+ tools 都能进 piece
    const segments = s.compatSegments
    const toolsArr = s.compatTools
    const chunks = groupSegmentsForExploringDisplay(segments, toolsArr, false, true)
    const activityChunks = chunks.filter((c) => c.kind === 'activity')
    expect(activityChunks.length, '应有 1 个 activity chunk').toBe(1)
    const actChunk = activityChunks[0]
    const toolPieces = actChunk?.kind === 'activity' ? actChunk.pieces.filter((p) => p.kind === 'tools') : []
    const totalIds = toolPieces.reduce(
      (acc, p) => acc + (p.kind === 'tools' ? p.ids.length : 0),
      0,
    )
    // v5.9 fix：streaming 期每个 id 都要能 resolve → 进入 piece
    expect(totalIds, `streaming 期间 tools 段 ids 应全进 piece (实际 ${totalIds} / ${segIds.length})`).toBe(segIds.length)

    // 关键：走真实 dom-view 路径 — buildAssistantDomView 喂入 row.tools 后 chunks 数
    const proj = projectAgUiToStreamTurnFields(s)
    const row = {
      role: '_stream',
      segments,
      tools: toolsArr,
      text: proj.openText,
      reasoningPreview: proj.reasoningPreview || '',
      reasoningSegments: proj.reasoningSegments || [],
    }
    const plan = buildAssistantBubbleDisplayPlan({
      row,
      displaySegments: segments,
      tools: toolsArr,
      rawText: proj.openText,
      text: proj.openText,
      textTrimmed: false,
      reasoningPreview: proj.reasoningPreview || '',
      reasoningSegments: proj.reasoningSegments || [],
      isStreaming: true,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: true,
      systemActivityLabel: '',
      streamThinkingLabel: '',
      legacyHasTools: false,
      legacyShowBody: false,
      plainBodyRaw: '',
      plainShowThinkingCursor: false,
    })
    const domChunks = buildAssistantDomView({
      row,
      plan,
      isStreaming: true,
      workedLabel: 'streaming',
    })
    // 找出 activity chunk 里的 tools piece
    const actChunkDom = domChunks.chunks.find((c) => c.kind === 'flat-activity')
    if (actChunkDom?.kind !== 'flat-activity') {
      throw new Error('dom-view 应含 flat-activity chunk')
    }
    const toolPieceCount = actChunkDom.pieces.reduce(
      (acc, p) => acc + (p.kind === 'tools' ? p.tools.length : 0),
      0,
    )
    expect(
      toolPieceCount,
      `dom-view tools piece count 应 = segIds.length (实际 ${toolPieceCount} / ${segIds.length})`,
    ).toBe(segIds.length)
  })
})
