import { describe, expect, it } from 'vitest'
import {
  buildStreamTimelineLayout,
  ensureReasoningBeforeFirstTextWhenNoTools,
  layoutSegmentsWithOpenReasoning,
  resolveStreamLiveTailSlot,
} from '../src/react/lib/message-row-stream-layout.ts'

describe('message-row-stream-layout', () => {
  it('buildStreamTimelineLayout groups text segments into display chunks', () => {
    const layout = buildStreamTimelineLayout({
      row: { role: 'assistant', text: 'live tail' },
      displaySegments: [{ kind: 'text', text: 'plan\n\nreply' }],
      tools: [],
      rawText: 'live tail',
      textTrimmed: false,
      reasoningSegments: [],
      reasoningPreview: '',
      isStreaming: true,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: false,
      useTimelineReasoningUi: false,
    })
    expect(layout.displayChunks.length).toBeGreaterThan(0)
    expect(layout.firstActivityChunkIndex).toBe(-1)
  })

  it('resolveStreamLiveTailSlot returns null when tail is contained in chunks', () => {
    const layout = buildStreamTimelineLayout({
      row: { role: 'assistant', text: 'same' },
      displaySegments: [{ kind: 'text', text: 'same' }],
      tools: [],
      rawText: 'same',
      textTrimmed: false,
      reasoningSegments: [],
      reasoningPreview: '',
      isStreaming: false,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: false,
      useTimelineReasoningUi: false,
    })
    const slot = resolveStreamLiveTailSlot({
      layout,
      displaySegments: [{ kind: 'text', text: 'same' }],
      displayChunks: layout.displayChunks,
      isStreaming: false,
      suppressPlanExecPromptNoise: false,
    })
    expect(slot).toBeNull()
  })

  it('post-tool live reasoning stays inside Exploring (not reasoning-pending)', async () => {
    const { buildAssistantBubbleDisplayPlan } = await import(
      '../src/react/lib/message-row-display-plan.ts'
    )
    const displaySegments = [
      { kind: 'reasoning', text: 'old' },
      { kind: 'tools', ids: ['t1'] },
      { kind: 'reasoning', text: 'live think' },
    ]
    const plan = buildAssistantBubbleDisplayPlan({
      row: { role: 'assistant', text: '' },
      displaySegments,
      tools: [{ id: 't1', name: 'read_file' }],
      rawText: '',
      text: '',
      textTrimmed: false,
      reasoningPreview: 'live think',
      reasoningSegments: ['live think'],
      isStreaming: true,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: true,
      systemActivityLabel: '',
      streamThinkingLabel: '正在思考...',
      legacyHasTools: true,
      legacyShowBody: false,
      plainBodyRaw: '',
      plainShowThinkingCursor: false,
    })
    expect(plan.slots.some((s) => s.kind === 'reasoning-pending')).toBe(false)
    const exploring = plan.slots.find((s) => s.kind === 'chunk' && s.chunk.kind === 'activity')
    expect(
      exploring?.kind === 'chunk' &&
        exploring.chunk.kind === 'activity' &&
        exploring.chunk.pieces.some(
          (p) => p.kind === 'reasoning' && String(p.text).includes('live think'),
        ),
    ).toBe(true)
  })

  it('keeps second-round open reasoning after trailing text and tools (arrival order)', () => {
    const layout = buildStreamTimelineLayout({
      row: { role: '_stream', text: '', streamTextPhase: 'post_tools' },
      displaySegments: [
        { kind: 'reasoning', text: 'round one' },
        { kind: 'text', text: '旁白' },
        { kind: 'tools', ids: ['t1'] },
      ],
      tools: [{ id: 't1', name: 'read', status: 'ok' }],
      rawText: '',
      textTrimmed: false,
      reasoningSegments: ['round one'],
      reasoningPreview: 'round two streaming',
      isStreaming: true,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: true,
      useTimelineReasoningUi: true,
    })
    const chunk = layout.displayChunks.find((c) => c.kind === 'activity')
    expect(chunk?.kind).toBe('activity')
    const kinds = chunk?.kind === 'activity' ? chunk.pieces.map((p) => p.kind) : []
    const lastReasoning = chunk?.kind === 'activity'
      ? [...chunk.pieces].reverse().find((p) => p.kind === 'reasoning')
      : null
    // 新思考保持在到达位置（工具之后），不再上提到正文之前
    // 「旁白」过短可能被 plan/noise 过滤，不强制要求 text piece 仍在 fold 内
    expect(kinds.filter((k) => k === 'reasoning').length).toBe(2)
    expect(kinds.lastIndexOf('reasoning')).toBeGreaterThan(kinds.indexOf('tools'))
    expect(String(lastReasoning?.text || '')).toContain('round two')
  })

  it('inserts open reasoning before body text when text segment raced ahead (no tools)', () => {
    const ordered = layoutSegmentsWithOpenReasoning({
      displaySegments: [{ kind: 'text', text: '你好世界' }],
      reasoningPreview: '先分析用户意图',
      isStreaming: true,
    })
    expect(ordered.map((s) => s.kind)).toEqual(['reasoning', 'text'])

    const layout = buildStreamTimelineLayout({
      row: { role: '_stream', text: '你好世界', streamTextPhase: 'pre_tools' },
      displaySegments: [{ kind: 'text', text: '你好世界' }],
      tools: [],
      rawText: '你好世界',
      textTrimmed: true,
      reasoningSegments: [],
      reasoningPreview: '先分析用户意图',
      isStreaming: true,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: false,
      useTimelineReasoningUi: false,
    })
    expect(layout.lastReasoningSegIdx).toBe(0)
    const activityIdx = layout.firstActivityChunkIndex
    expect(activityIdx).toBeGreaterThanOrEqual(0)
    const textIdx = layout.displayChunks.findIndex((c) => c.kind === 'text')
    if (textIdx >= 0) {
      expect(activityIdx).toBeLessThan(textIdx)
    }
  })

  it('ensureReasoningBeforeFirstTextWhenNoTools fixes segment order without reasoningPreview', () => {
    const fixed = ensureReasoningBeforeFirstTextWhenNoTools([
      { kind: 'text', text: '你好世界' },
      { kind: 'reasoning', text: '先分析用户意图', id: 'rm1' },
    ])
    expect(fixed.map((s) => s.kind)).toEqual(['reasoning', 'text'])

    const layout = buildStreamTimelineLayout({
      row: { role: '_stream', text: '你好世界', streamTextPhase: 'pre_tools' },
      displaySegments: [
        { kind: 'text', text: '你好世界' },
        { kind: 'reasoning', text: '先分析用户意图', id: 'rm1' },
      ],
      tools: [],
      rawText: '你好世界',
      textTrimmed: true,
      reasoningSegments: [],
      reasoningPreview: '',
      isStreaming: true,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: false,
      useTimelineReasoningUi: false,
    })
    const activityIdx = layout.firstActivityChunkIndex
    const textIdx = layout.displayChunks.findIndex((c) => c.kind === 'text')
    expect(activityIdx).toBeGreaterThanOrEqual(0)
    if (textIdx >= 0) expect(activityIdx).toBeLessThan(textIdx)
  })

  it('buildStreamTimelineLayout injects open AG-UI reasoning into Exploring fold', () => {
    const layout = buildStreamTimelineLayout({
      row: { role: '_stream', text: '', streamTextPhase: 'pre_tools' },
      displaySegments: [],
      tools: [],
      rawText: '',
      textTrimmed: false,
      reasoningSegments: [],
      reasoningPreview: 'streaming thought delta',
      isStreaming: true,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: false,
      useTimelineReasoningUi: false,
    })
    expect(layout.firstActivityChunkIndex).toBeGreaterThanOrEqual(0)
    expect(layout.lastReasoningSegIdx).toBe(0)
    expect(layout.lastTimelineSegmentKind).toBe('reasoning')
    const chunk = layout.displayChunks[layout.firstActivityChunkIndex]
    expect(chunk?.kind).toBe('activity')
    expect(
      chunk?.kind === 'activity' &&
        chunk.pieces.some(
          (p) => p.kind === 'reasoning' && String(p.text).includes('streaming thought'),
        ),
    ).toBe(true)
  })

  it('lastTimelineSegmentKind is tools while waiting for post-tool reasoning', () => {
    const layout = buildStreamTimelineLayout({
      row: { role: '_stream', text: '', streamTextPhase: 'post_tools' },
      displaySegments: [
        { kind: 'reasoning', text: 'round one' },
        { kind: 'tools', ids: ['t1'] },
      ],
      tools: [{ id: 't1', name: 'read', status: 'running' }],
      rawText: '',
      textTrimmed: false,
      reasoningSegments: ['round one'],
      reasoningPreview: 'round one',
      isStreaming: true,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: true,
      useTimelineReasoningUi: true,
    })
    expect(layout.lastTimelineSegmentKind).toBe('tools')
    expect(layout.lastReasoningSegIdx).toBe(0)
  })

  it('streaming layout keeps tool batches split across interleaved reasoning', () => {
    const layout = buildStreamTimelineLayout({
      row: { role: '_stream', text: '', streamTextPhase: 'post_tools' },
      displaySegments: [
        { kind: 'reasoning', text: 'round1 think', seq: 1 },
        { kind: 'tools', ids: ['t1', 't2'], seq: 2 },
        { kind: 'reasoning', text: 'between batches', seq: 3 },
        { kind: 'tools', ids: ['t3'], seq: 4 },
      ],
      tools: [
        { id: 't1', name: 'grep', status: 'ok' },
        { id: 't2', name: 'read', status: 'ok' },
        { id: 't3', name: 'rg', status: 'running' },
      ],
      rawText: '',
      textTrimmed: false,
      reasoningSegments: ['round1 think', 'between batches'],
      reasoningPreview: 'between batches',
      isStreaming: true,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: true,
      useTimelineReasoningUi: true,
    })
    const act = layout.displayChunks.find((c) => c.kind === 'activity')
    expect(act?.pieces.map((p) => p.kind)).toEqual(['reasoning', 'tools', 'reasoning', 'tools'])
    const toolPieces = act?.pieces.filter((p) => p.kind === 'tools') || []
    expect(toolPieces[0]?.ids).toEqual(['t1', 't2'])
    expect(toolPieces[1]?.ids).toEqual(['t3'])
  })

  // 新一轮 reasoningPreview 追加到末尾，保持到达顺序。
  // 新思考跟在正文/工具之后，不再上提到正文之前。
  it('open reasoning stays after inter-exploring text and following tools (arrival order)', () => {
    const layout = buildStreamTimelineLayout({
      row: { role: '_stream', text: '我先快速梳理几个核心模块', streamTextPhase: 'post_tools' },
      displaySegments: [
        { kind: 'reasoning', text: 'round1' },
        { kind: 'tools', ids: ['t1'] },
        { kind: 'reasoning', text: 'round2' },
        { kind: 'tools', ids: ['t2'] },
        { kind: 'text', text: '我先快速梳理几个核心模块的页面，再给你一份结构化说明。' },
        { kind: 'tools', ids: ['subagent1'] },
      ],
      tools: [
        { id: 't1', name: 'read', status: 'ok' },
        { id: 't2', name: 'read', status: 'ok' },
        { id: 'subagent1', name: 'task', status: 'running' },
      ],
      rawText: '我先快速梳理几个核心模块的页面，再给你一份结构化说明。',
      textTrimmed: true,
      reasoningSegments: ['round1', 'round2'],
      reasoningPreview: '用户需要结构化功能介绍。我将先梳理提及的功能模块。',
      isStreaming: true,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: true,
      useTimelineReasoningUi: true,
    })
    const act = layout.displayChunks.find((c) => c.kind === 'activity')
    expect(act?.pieces.map((p) => p.kind)).toEqual([
      'reasoning',
      'tools',
      'reasoning',
      'tools',
      'text',
      'tools',
      'reasoning',
    ])
    const reasoningTexts =
      act?.pieces.filter((p) => p.kind === 'reasoning').map((p) => p.text) || []
    expect(reasoningTexts[2]).toContain('结构化功能介绍')
    const openPiece = act?.pieces.find(
      (p) => p.kind === 'reasoning' && p.id === '__open_reasoning__',
    )
    expect(openPiece).toBeTruthy()
  })

  // 首段 Thinking 已进 Exploring 后，工具轮次不应再把 sealed preview 插到最新工具下方。
  it('does not resurrect sealed first-thinking under latest tools from stale preview', async () => {
    const { buildAssistantBubbleDisplayPlan } = await import(
      '../src/react/lib/message-row-display-plan.ts'
    )
    const { mergeAssistantRowWithStreamRow } = await import(
      '../src/react/lib/merge-assistant-stream-row.ts'
    )
    const firstThink = '第一轮思考：先读目录再决定下一步。'

    // live 仅新工具 + stale preview：不得尾插 Thinking
    const orphanLive = layoutSegmentsWithOpenReasoning({
      displaySegments: [{ kind: 'tools', ids: ['t2'], seq: 3 }],
      reasoningPreview: firstThink,
      isStreaming: true,
    })
    expect(orphanLive.map((s) => s.kind)).toEqual(['tools'])

    const assistant = {
      role: 'assistant',
      incompleteStream: true,
      text: '',
      segments: [
        { kind: 'reasoning', text: firstThink, seq: 1, id: 'rm1' },
        { kind: 'tools', ids: ['t1'], seq: 2 },
      ],
      tools: [{ id: 't1', name: 'read', status: 'ok' }],
      reasoningPreview: firstThink,
      reasoningSegments: [firstThink],
    }
    const stream = {
      role: '_stream',
      text: '',
      segments: [{ kind: 'tools', ids: ['t2'], seq: 3 }],
      tools: [{ id: 't2', name: 'grep', status: 'running' }],
      reasoningPreview: null,
      reasoningSegments: [],
      streamTextPhase: 'post_tools',
    }
    const merged = mergeAssistantRowWithStreamRow(assistant, stream)
    expect(merged.reasoningPreview == null || !String(merged.reasoningPreview).trim()).toBe(true)

    const plan = buildAssistantBubbleDisplayPlan({
      row: { ...merged, role: '_stream', streamTextPhase: 'post_tools' },
      displaySegments: merged.segments || [],
      tools: merged.tools || [],
      rawText: '',
      text: '',
      textTrimmed: false,
      reasoningPreview: String(merged.reasoningPreview || ''),
      reasoningSegments: merged.reasoningSegments || [],
      isStreaming: true,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: true,
      systemActivityLabel: '',
      streamThinkingLabel: '思考中',
      legacyHasTools: true,
      legacyShowBody: false,
      plainBodyRaw: '',
      plainShowThinkingCursor: false,
    })
    const act = plan.slots.find((s) => s.kind === 'chunk' && s.chunk?.kind === 'activity')
    const pieces = act?.chunk?.pieces || []
    const thinkPieces = pieces.filter((p) => p.kind === 'reasoning')
    expect(thinkPieces.length).toBe(1)
    expect(String(thinkPieces[0]?.text || '')).toContain('第一轮思考')
    expect(pieces.map((p) => p.kind).lastIndexOf('reasoning')).toBeLessThan(
      pieces.map((p) => p.kind).lastIndexOf('tools'),
    )
  })
})
