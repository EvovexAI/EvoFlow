// v5.9 regression: 复现用户反馈"显示 4-5 个工具后，又显示工具，但前面的工具看不到"
//
// 真实 run-133609527d1f：7 个工具串行（write/read/rg/replace/...），
// dom-view 长期只显示 2 个 tool piece (piece#0 + piece#1)，但 sse 端实际跑了 7 个工具。
// 假设：流式期间 groupSegmentsForExploringDisplay 在 tools segment 上做 findToolByCallId 时，
//   如果 row.tools 数组里没那个 tool，streaming 期直接 continue 跳过。
//   → 7 个工具里 5 个 id 在 row.tools 里没找到 → 显示 2 个。
//
// 此测试直接走 dom-view 路径（applyAgUiEvent → compatTools → row → buildAssistantDomView），
// 验证：跑到第 4 个工具 done + 第 5 个工具 running 时，dom-view 应显示 ≥ 4 个 tool piece。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { applyAgUiEvent, emptyAgUiTurnState, shouldReleaseAgUiBufferBeforeToolStart, drainAgUiCompletedRound } from '../src/react/lib/agui-turn-reducer.ts'
import { buildAssistantDomView } from '../src/react/lib/assistant-dom-view.ts'
import { buildAssistantBubbleDisplayPlan } from '../src/react/lib/message-row-display-plan.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = join(__dirname, 'fixtures', 'agui', 'run-133609527d1f-sse.jsonl')

function loadRealRunEvents() {
  const raw = readFileSync(FIXTURE_PATH, 'utf8')
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function buildDomView(s, proj, isStreaming) {
  const segments = s.compatSegments
  const toolsArr = s.compatTools
  const plan = buildAssistantBubbleDisplayPlan({
    row: { role: '_stream', segments, tools: toolsArr },
    displaySegments: segments,
    tools: toolsArr,
    rawText: proj.openText,
    text: proj.openText,
    textTrimmed: !!String(proj.openText || '').trim(),
    reasoningPreview: proj.reasoningPreview || '',
    reasoningSegments: proj.reasoningSegments || [],
    isStreaming,
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
  return buildAssistantDomView({
    row: { role: '_stream', segments, tools: toolsArr, text: proj.openText },
    plan,
    isStreaming,
    workedLabel: isStreaming ? 'streaming' : 'sealed',
  })
}

describe('v5.9 regression: 多轮工具流式期不应消失', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('4 done + 1 running: dom-view 应显示 ≥ 4 个 tool piece', () => {
    const events = loadRealRunEvents()
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

    expect(s.compatTools.length, 'compatTools 应 ≥ 5 (4 done + 1 running)').toBeGreaterThanOrEqual(5)
    const toolsSeg = s.compatSegments.find((seg) => seg.kind === 'tools')
    expect(toolsSeg, 'compatSegments 应含 1 个 tools 段').toBeTruthy()
    const segIds = toolsSeg?.kind === 'tools' ? toolsSeg.ids : []
    expect(segIds.length, 'tools 段 ids 应 ≥ 5').toBeGreaterThanOrEqual(5)

    // 关键：每个 segId 在 compatTools 都能 resolve
    const allIds = new Set(s.compatTools.map((t) => String(t.id || t.tool_call_id || '')))
    const unresolved = segIds.filter((id) => !allIds.has(id))
    expect(unresolved, 'row.tools 应能 resolve 所有 segIds').toEqual([])

    // 走真实 dom-view 路径
    const proj = {
      openText: '',
      reasoningPreview: '',
      reasoningSegments: [],
    }
    const dom = buildDomView(s, proj, true)
    const actChunk = dom.chunks.find((c) => c.kind === 'flat-activity')
    if (!actChunk || actChunk.kind !== 'flat-activity') {
      throw new Error('dom-view 应含 flat-activity chunk')
    }
    const toolPieceCount = actChunk.pieces.reduce(
      (acc, p) => acc + (p.kind === 'tools' ? p.tools.length : 0),
      0,
    )
    expect(
      toolPieceCount,
      `streaming 期 dom-view 应显示 ≥ 4 个 tool piece (实际 ${toolPieceCount} / segIds=${segIds.length})`,
    ).toBeGreaterThanOrEqual(4)
  })

  it('7 done: dom-view 应显示 ≥ 7 个 tool piece', () => {
    const events = loadRealRunEvents()
    let s = emptyAgUiTurnState('run-133609527d1f', 'c98622f1-6149-4abc-b0b6-dd00e94657e9')
    for (const ev of events) {
      vi.setSystemTime(new Date(Date.now() + 30))
      s = applyAgUiEvent(s, ev)
    }

    expect(s.compatTools.length, 'compatTools 应 = 7').toBe(7)
    const toolsSeg = s.compatSegments.find((seg) => seg.kind === 'tools')
    const segIds = toolsSeg?.kind === 'tools' ? toolsSeg.ids : []
    expect(segIds.length, 'tools 段 ids 应 = 7').toBe(7)

    // sealed 期 dom-view
    const proj = {
      openText: '',
      reasoningPreview: '',
      reasoningSegments: [],
    }
    const dom = buildDomView(s, proj, false)
    const actChunk = dom.chunks.find((c) => c.kind === 'flat-activity')
    if (!actChunk || actChunk.kind !== 'flat-activity') {
      throw new Error('dom-view 应含 flat-activity chunk')
    }
    const toolPieceCount = actChunk.pieces.reduce(
      (acc, p) => acc + (p.kind === 'tools' ? p.tools.length : 0),
      0,
    )
    expect(
      toolPieceCount,
      `sealed 期 dom-view 应显示 7 个 tool piece (实际 ${toolPieceCount} / segIds=${segIds.length})`,
    ).toBe(7)
  })

  it('7 done: compatSegments 投影应只 1 个 tools 段（不重复 ids 跨段）', () => {
    const events = loadRealRunEvents()
    let s = emptyAgUiTurnState('run-133609527d1f', 'c98622f1-6149-4abc-b0b6-dd00e94657e9')
    for (const ev of events) {
      vi.setSystemTime(new Date(Date.now() + 30))
      s = applyAgUiEvent(s, ev)
    }
    const toolsSegs = s.compatSegments.filter((seg) => seg.kind === 'tools')
    expect(toolsSegs.length, `7 tool 同 blockId 应合并为 1 tools 段，实际 ${toolsSegs.length} 段`).toBe(1)
    const totalIds = toolsSegs.reduce(
      (acc, seg) => acc + (seg.kind === 'tools' ? seg.ids.length : 0),
      0,
    )
    expect(totalIds, `tools 段总 ids 应 = 7，实际 ${totalIds}`).toBe(7)
  })

  it('同 blockId 7 工具串行 START/RESULT：每个 START 触发 shouldReleaseAgUiBufferBeforeToolStart + drain 1 个', () => {
    // v5.9 fix 复现：drainAgUiCompletedRound 在每次 TOOL_CALL_START 时都触发，
    // 7 工具 6 次 drain（除第一次 START）→ 6 个 sealed part + 1 fresh = 6 piece 1 id each
    // 这是用户反馈"显示了 4-5 个工具后又显示工具，前面工具看不到"的根因。
    // 期望：shouldReleaseAgUiBufferBeforeToolStart 在新 blockId 或 sealed round boundary 才返回 true。
    const events = loadRealRunEvents()
    let s = emptyAgUiTurnState('run-133609527d1f', 'c98622f1-6149-4abc-b0b6-dd00e94657e9')
    let startCount = 0
    let releaseCount = 0
    let sealedCount = 0
    const sealedPartsLog = []
    for (const ev of events) {
      vi.setSystemTime(new Date(Date.now() + 30))
      if (
        ev.type === 'TOOL_CALL_START' &&
        shouldReleaseAgUiBufferBeforeToolStart(s, ev)
      ) {
        releaseCount++
        const { sealed, fresh } = drainAgUiCompletedRound(s)
        s = fresh
        if (sealed) {
          sealedCount++
          sealedPartsLog.push({
            segmentsN: sealed.segments.length,
            toolsN: (sealed.tools || []).length,
            toolsSegIdsN: sealed.segments
              .filter((seg) => seg.kind === 'tools')
              .reduce((acc, seg) => acc + (seg.kind === 'tools' ? seg.ids.length : 0), 0),
          })
        }
      }
      s = applyAgUiEvent(s, ev)
      if (ev.type === 'TOOL_CALL_START') startCount++
    }
    console.log(
      `startCount=${startCount} releaseCount=${releaseCount} sealedCount=${sealedCount}`,
    )
    // 7 工具串行：每次 START 触发 1 个 done tool seal
    expect(
      releaseCount,
      `7 工具串行应触发 ≈ 6 次 release（每次 START 1 个 done tool），实际 ${releaseCount}`,
    ).toBeGreaterThanOrEqual(5)
    // 模拟真实 dev：每次 drain 后替换 fresh，sealed part 实际只含 1 个 done tool（1 id）
    for (let i = 0; i < sealedPartsLog.length; i++) {
      expect(
        sealedPartsLog[i].toolsSegIdsN,
        `part#${i} 应只 1 id, 实际 ${sealedPartsLog[i].toolsSegIdsN}`,
      ).toBe(1)
    }
  })

  it('同 blockId 6 单 id 段：mergeCompactedPartsIntoTurn 后应合段为 1 段多 ids', async () => {
    // v5.9 fix：mergeConsecutiveSingleIdToolsSegments 把连续同 id-blockId 单 id 段合并
    const { mergeCompactedPartsIntoTurn } = await import(
      '../src/react/lib/stream-turn-engine.ts'
    )
    const sealed = [
      {
        segments: [
          { kind: 'tools', ids: ['a'], id: 'block:1', blockKind: 'tools' },
        ],
        tools: [{ id: 'a', tool_call_id: 'a' }],
        text: '',
        images: [],
        videos: [],
        audios: [],
        files: [],
      },
      {
        segments: [
          { kind: 'tools', ids: ['b'], id: 'block:1', blockKind: 'tools' },
        ],
        tools: [{ id: 'b', tool_call_id: 'b' }],
        text: '',
        images: [],
        videos: [],
        audios: [],
        files: [],
      },
      {
        segments: [
          { kind: 'tools', ids: ['c'], id: 'block:1', blockKind: 'tools' },
        ],
        tools: [{ id: 'c', tool_call_id: 'c' }],
        text: '',
        images: [],
        videos: [],
        audios: [],
        files: [],
      },
    ]
    const turn = {
      timeline: [],
      openText: '',
      textPhase: 'pre_tools',
      tools: [],
      reasoningPendingNewRound: false,
      images: [],
      videos: [],
      audios: [],
      files: [],
      systemActivity: null,
      systemActivityKind: null,
      systemActivityStartedAt: null,
      blocks: {},
      blockOrder: [],
      phaseHistory: [],
    }
    const merged = mergeCompactedPartsIntoTurn(sealed, turn)
    const toolsSegs = merged.timeline.filter((s) => s.kind === 'tools')
    expect(toolsSegs.length, `3 单 id 段同 id-blockId 应合段为 1 段，实际 ${toolsSegs.length} 段`).toBe(1)
    const totalIds = toolsSegs.reduce(
      (acc, s) => acc + (s.kind === 'tools' ? s.ids.length : 0),
      0,
    )
    expect(totalIds, `合段后 ids 应 = 3，实际 ${totalIds}`).toBe(3)
  })

  it('真实 sealed 阶段：7 工具串行 6 parts + 1 fresh 完整 dom-view 7 tools', async () => {
    // 模拟 ChatApp 实际流：每次 START 触发 drain，compactedParts push 1 part。
    // 6 START 触发 6 drains → 6 parts in compactedParts。
    // 第 7 tool 仍在 live state.compatSegments 中。
    // sealed 时调用 mergeCompactedPartsIntoTurn 重建 turn.timeline：
    // 6 个 1-id 段 + 1 个 1-id live 段 → merge → 1 段 6 ids + 1 段 1 id = 2 段 7 ids。
    const { mergeCompactedPartsIntoTurn } = await import(
      '../src/react/lib/stream-turn-engine.ts'
    )
    const events = loadRealRunEvents()
    let s = emptyAgUiTurnState('run-133609527d1f', 'c98622f1-6149-4abc-b0b6-dd00e94657e9')
    const compactedParts = []
    for (const ev of events) {
      vi.setSystemTime(new Date(Date.now() + 30))
      if (
        ev.type === 'TOOL_CALL_START' &&
        shouldReleaseAgUiBufferBeforeToolStart(s, ev)
      ) {
        const { sealed, fresh } = drainAgUiCompletedRound(s)
        s = fresh
        if (sealed) compactedParts.push(sealed)
      }
      s = applyAgUiEvent(s, ev)
    }
    // 7 工具串行 6 drains → 6 compacted parts
    expect(compactedParts.length, `6 compactedParts, 实际 ${compactedParts.length}`).toBe(6)
    // sealed turn: 6 parts 各 1 段 1 id + live 1 段 1 id → merge 1 段 6 ids + 1 段 1 id = 2 段
    const sealedTurn = {
      timeline: [...s.compatSegments],
      openText: '',
      textPhase: 'pre_tools',
      tools: [...s.compatTools],
      reasoningPendingNewRound: false,
      images: [],
      videos: [],
      audios: [],
      files: [],
      systemActivity: null,
      systemActivityKind: null,
      systemActivityStartedAt: null,
      blocks: {},
      blockOrder: [],
      phaseHistory: [],
    }
    const merged = mergeCompactedPartsIntoTurn(compactedParts, sealedTurn)
    const toolsSegs = merged.timeline.filter((seg) => seg.kind === 'tools')
    // 6 个 1-id sealed → merge 1 段 6 ids; live 1-id 段保留 = 2 段
    expect(
      toolsSegs.length,
      `merge 后应 = 2 tools 段（1 sealed 合并 + 1 live），实际 ${toolsSegs.length} 段: segToolIds=[${toolsSegs
        .map((s) => s.kind === 'tools' ? s.ids.length : 0)
        .join(',')}]`,
    ).toBe(2)
    const totalIds = toolsSegs.reduce(
      (acc, seg) => acc + (seg.kind === 'tools' ? seg.ids.length : 0),
      0,
    )
    expect(totalIds, `7 unique ids, 实际 ${totalIds}`).toBe(7)
  })

  it('不同 seg.id 7 单 id 段：mergeCompactedPartsIntoTurn 后应合段为 1 段多 ids', async () => {
    // v5.9 强化：real run 中 sealed parts 各 1 段 1 id，但 seg.id 可能是
    //   entry.blockId（如果 blockId 缺失）or "tools-{tool_call_id}"（fallback）
    // 若 blockId 缺失，sealed 段 seg.id 各自不同 → 旧版「要求 seg.id 相同」
    //   的合段逻辑不触发，dev 端 log 仍 7 段 1 id each。修复：不要求 seg.id 相同。
    const { mergeCompactedPartsIntoTurn } = await import(
      '../src/react/lib/stream-turn-engine.ts'
    )
    const sealed = Array.from({ length: 7 }, (_, i) => ({
      segments: [
        { kind: 'tools', ids: [`tool_${i}`], id: `tools-call_00_${i}`, blockKind: 'tools' },
      ],
      tools: [{ id: `tool_${i}`, tool_call_id: `tool_${i}` }],
      text: '',
      images: [],
      videos: [],
      audios: [],
      files: [],
    }))
    const turn = {
      timeline: [],
      openText: '',
      textPhase: 'pre_tools',
      tools: [],
      reasoningPendingNewRound: false,
      images: [],
      videos: [],
      audios: [],
      files: [],
      systemActivity: null,
      systemActivityKind: null,
      systemActivityStartedAt: null,
      blocks: {},
      blockOrder: [],
      phaseHistory: [],
    }
    const merged = mergeCompactedPartsIntoTurn(sealed, turn)
    const toolsSegs = merged.timeline.filter((s) => s.kind === 'tools')
    expect(toolsSegs.length, `7 不同 seg.id 1-id 段应合段为 1 段，实际 ${toolsSegs.length} 段`).toBe(1)
    const totalIds = toolsSegs.reduce(
      (acc, s) => acc + (s.kind === 'tools' ? s.ids.length : 0),
      0,
    )
    expect(totalIds, `合段后 ids 应 = 7，实际 ${totalIds}`).toBe(7)
  })

  it('真实 run-133609527d1f 6 个 1-id sealed + 1 fresh：merge 后应 1 段 7 ids (含 fresh delete)', async () => {
    // 完整端到端：模拟 ChatApp 路径（每 START 触发 drain，drain 替换 fresh），
    // 然后 merge 6 sealed part + fresh turn，验证 timeline = 1 段 7 ids。
    const { mergeCompactedPartsIntoTurn } = await import(
      '../src/react/lib/stream-turn-engine.ts'
    )
    const events = loadRealRunEvents()
    let s = emptyAgUiTurnState('run-133609527d1f', 'c98622f1-6149-4abc-b0b6-dd00e94657e9')
    const sealedParts = []
    for (const ev of events) {
      vi.setSystemTime(new Date(Date.now() + 30))
      if (
        ev.type === 'TOOL_CALL_START' &&
        shouldReleaseAgUiBufferBeforeToolStart(s, ev)
      ) {
        const { sealed, fresh } = drainAgUiCompletedRound(s)
        s = fresh
        if (sealed) sealedParts.push(sealed)
      }
      s = applyAgUiEvent(s, ev)
    }
    // 7 工具串行：应有 6 个 sealed part
    expect(sealedParts.length, `7 工具串行应 = 6 sealed parts，实际 ${sealedParts.length}`).toBe(6)
    // merge 6 sealed + fresh (delete) → 1 段 7 ids
    const freshTurn = {
      timeline: [...s.compatSegments],
      openText: '',
      textPhase: 'pre_tools',
      tools: [...s.compatTools],
      reasoningPendingNewRound: false,
      images: [],
      videos: [],
      audios: [],
      files: [],
      systemActivity: null,
      systemActivityKind: null,
      systemActivityStartedAt: null,
      blocks: {},
      blockOrder: [],
      phaseHistory: [],
    }
    const merged = mergeCompactedPartsIntoTurn(sealedParts, freshTurn)
    const toolsSegs = merged.timeline.filter((seg) => seg.kind === 'tools')
    // 6 sealed 1-id 段 (同 id-blockId) → 1 段 6 ids; fresh 段 (1 id delete) → 1 段 1 id
    // dedupe 后：2 段 (1 段 6 ids + 1 段 1 id delete) = 7 unique ids
    expect(
      toolsSegs.length,
      `merge 后应 = 2 tools 段（1 sealed 合并 + 1 fresh delete），实际 ${toolsSegs.length} 段`,
    ).toBe(2)
    const totalIds = toolsSegs.reduce(
      (acc, seg) => acc + (seg.kind === 'tools' ? seg.ids.length : 0),
      0,
    )
    expect(totalIds, `ids 总数应 = 7，实际 ${totalIds}`).toBe(7)
    // 验证 6 个 sealed ids + 1 fresh delete id 都在
    const allIds = toolsSegs.flatMap((seg) => (seg.kind === 'tools' ? seg.ids : []))
    expect(new Set(allIds).size, '7 个 unique ids').toBe(7)
  })
})
