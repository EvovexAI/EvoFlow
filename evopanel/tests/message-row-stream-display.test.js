import { describe, expect, it } from 'vitest'
import {
  displayChunksHaveReasoningPieces,
  findPlanTopTextChunk,
  hasVisibleBodyBelowActivityChunk,
  resolveFinalReplyFallbackSlot,
  shouldHideFinalReplyTextChunkInMap,
  shouldHideStreamingPostToolsTextChunk,
  shouldRenderFinalReplyAtBottomOnly,
  shouldShowStreamPlanAtTop,
  shouldSuppressLiveTailDuringPreToolReasoning,
  streamLiveTailContainedInDisplay,
} from '../src/react/lib/message-row-stream-display.ts'
import { isReasoningFullyRenderedInChunks } from '../src/react/lib/message-row-reasoning-render.ts'
import {
  expandToolsForFilterResolution,
  resolveToolByFilterId,
  toolFilterIdAliases,
  toolIdsMatchFilter,
} from '../src/react/lib/tool-filter-id-resolve.ts'

describe('message-row-stream-display', () => {
  it('shouldHideStreamingPostToolsTextChunk hides only active final reply while streaming', () => {
    expect(
      shouldHideStreamingPostToolsTextChunk(true, 'post_tools', 'text', 3, 1, 3),
    ).toBe(true)
    expect(
      shouldHideStreamingPostToolsTextChunk(true, 'post_tools', 'text', 2, 1, 3),
    ).toBe(false)
    expect(
      shouldHideStreamingPostToolsTextChunk(true, 'post_tools', 'text', 0, 1, 3),
    ).toBe(false)
    expect(
      shouldHideStreamingPostToolsTextChunk(false, 'post_tools', 'text', 3, 1, 3),
    ).toBe(false)
  })

  it('shouldHideFinalReplyTextChunkInMap keeps sealed mid-round text visible while streaming', () => {
    expect(
      shouldHideFinalReplyTextChunkInMap(2, 'text', true, 'post_tools', 1, 3),
    ).toBe(false)
  })

  it('hasVisibleBodyBelowActivityChunk false when only thinking-wait below', () => {
    const slots = [
      { kind: 'chunk', chunkIndex: 1, chunk: { kind: 'activity', pieces: [], startIndex: 0 } },
      { kind: 'thinking-wait', label: '思考中' },
    ]
    expect(hasVisibleBodyBelowActivityChunk(slots, 1)).toBe(false)
  })

  it('hasVisibleBodyBelowActivityChunk true when live-tail below activity', () => {
    const slots = [
      { kind: 'chunk', chunkIndex: 1, chunk: { kind: 'activity', pieces: [], startIndex: 0 } },
      { kind: 'live-tail', text: '## 最终汇报', isStreaming: true },
    ]
    expect(hasVisibleBodyBelowActivityChunk(slots, 1)).toBe(true)
  })

  it('resolveFinalReplyFallbackSlot fills idle gap after exploring fold', () => {
    const displayChunks = [
      { kind: 'activity', pieces: [{ kind: 'tools', ids: ['t1'] }], startIndex: 0 },
      { kind: 'text', text: '## 总结\n\n已完成验证。', segIndex: 2 },
    ]
    const slots = [
      { kind: 'chunk', chunkIndex: 0, chunk: displayChunks[0] },
    ]
    const hit = resolveFinalReplyFallbackSlot({
      isStreaming: false,
      firstActivityChunkIndex: 0,
      finalReplyChunkIndex: 1,
      renderFinalReplyAtBottom: true,
      liveTailPreviewText: '',
      displayChunks,
      slots,
      rawText: '## 总结\n\n已完成验证。',
      text: '## 总结\n\n已完成验证。',
      tools: [{ id: 't1', name: 'find', status: 'ok' }],
      suppressPlanExecPromptNoise: false,
    })
    expect(hit?.kind).toBe('live-tail')
    expect(String(hit?.text || '')).toContain('总结')
  })

  it('resolveFinalReplyFallbackSlot skips when live-tail already visible below', () => {
    const displayChunks = [
      { kind: 'activity', pieces: [{ kind: 'tools', ids: ['t1'] }], startIndex: 0 },
    ]
    const slots = [
      { kind: 'chunk', chunkIndex: 0, chunk: displayChunks[0] },
      { kind: 'live-tail', text: '最终答案在这里', isStreaming: false },
    ]
    expect(
      resolveFinalReplyFallbackSlot({
        isStreaming: false,
        firstActivityChunkIndex: 0,
        finalReplyChunkIndex: -1,
        renderFinalReplyAtBottom: false,
        liveTailPreviewText: '',
        displayChunks,
        slots,
        rawText: '最终答案在这里',
        text: '最终答案在这里',
        tools: [],
        suppressPlanExecPromptNoise: false,
      }),
    ).toBe(null)
  })

  it('resolveFinalReplyFallbackSlot skips while streaming', () => {
    expect(
      resolveFinalReplyFallbackSlot({
        isStreaming: true,
        firstActivityChunkIndex: 0,
        finalReplyChunkIndex: 1,
        renderFinalReplyAtBottom: true,
        liveTailPreviewText: 'streaming tail',
        displayChunks: [],
        slots: [],
        rawText: 'x',
        text: 'x',
        tools: [],
        suppressPlanExecPromptNoise: false,
      }),
    ).toBe(null)
  })

  it('resolveFinalReplyFallbackSlot does not dump inter-tool rawText when turn ends with tools', () => {
    const displayChunks = [
      { kind: 'text', text: '开场白', segIndex: 0 },
      {
        kind: 'activity',
        pieces: [
          { kind: 'reasoning', text: 'thinking', segIndex: 0 },
          { kind: 'tools', ids: ['t1'], segIndex: 1 },
          { kind: 'text', text: '工具间旁白一', segIndex: 2 },
          { kind: 'tools', ids: ['t2'], segIndex: 3 },
          { kind: 'text', text: '工具间旁白二', segIndex: 4 },
          { kind: 'tools', ids: ['t3'], segIndex: 5 },
        ],
        startIndex: 1,
      },
    ]
    const slots = [
      { kind: 'chunk', chunkIndex: 0, chunk: displayChunks[0] },
      { kind: 'chunk', chunkIndex: 1, chunk: displayChunks[1] },
    ]
    expect(
      resolveFinalReplyFallbackSlot({
        isStreaming: false,
        firstActivityChunkIndex: 1,
        finalReplyChunkIndex: -1,
        renderFinalReplyAtBottom: false,
        liveTailPreviewText: '',
        displayChunks,
        slots,
        rawText: '开场白\n\n工具间旁白一\n\n工具间旁白二',
        text: '开场白\n\n工具间旁白一\n\n工具间旁白二',
        tools: [
          { id: 't1', name: 'find', status: 'ok' },
          { id: 't2', name: 'read_file', status: 'ok' },
          { id: 't3', name: 'terminal', status: 'ok' },
        ],
        suppressPlanExecPromptNoise: false,
      }),
    ).toBe(null)
  })

  it('shouldRenderFinalReplyAtBottomOnly for post-activity final text', () => {
    expect(shouldRenderFinalReplyAtBottomOnly(2, 1)).toBe(true)
    expect(shouldRenderFinalReplyAtBottomOnly(0, 1)).toBe(false)
    expect(shouldRenderFinalReplyAtBottomOnly(-1, 1)).toBe(false)
  })

  it('shouldHideFinalReplyTextChunkInMap hides final reply in bottom slot only while streaming', () => {
    expect(
      shouldHideFinalReplyTextChunkInMap(2, 'text', true, 'post_tools', 1, 2),
    ).toBe(true)
    expect(
      shouldHideFinalReplyTextChunkInMap(2, 'text', false, 'post_tools', 1, 2),
    ).toBe(false)
    expect(
      shouldHideFinalReplyTextChunkInMap(0, 'text', false, 'post_tools', 1, 2),
    ).toBe(false)
  })

  it('streamLiveTailContainedInDisplay matches during streaming', () => {
    expect(streamLiveTailContainedInDisplay('', 'hello', '')).toBe(true)
    expect(streamLiveTailContainedInDisplay('同一段', '', '同一段')).toBe(true)
    expect(streamLiveTailContainedInDisplay('全新尾文', '计划', '旁白')).toBe(false)
  })

  it('streamLiveTailContainedInDisplay treats duplicate intro bodies as contained', () => {
    const intro =
      '## EvoFlow 是什么\n\nEvoFlow 是一个会动脑子的智能办事助手平台。\n\n| 类别 | 典型能力 |\n|------|----------|'
    expect(streamLiveTailContainedInDisplay(intro, intro, '')).toBe(true)
  })

  it('shouldShowStreamPlanAtTop always false (plan no longer special-cased)', () => {
    const base = {
      isStreaming: true,
      streamTextPhase: 'pre_tools',
      hasToolsInTurn: false,
      useTimelineReasoningUi: false,
      textTrimmed: true,
      planAlreadyInChunks: false,
    }
    expect(shouldShowStreamPlanAtTop({ ...base, firstActivityChunkIndex: -1 })).toBe(false)
    expect(shouldShowStreamPlanAtTop({ ...base, firstActivityChunkIndex: 0 })).toBe(false)
    expect(
      shouldShowStreamPlanAtTop({
        ...base,
        firstActivityChunkIndex: 0,
        firstActivityIsReasoningOnly: true,
      }),
    ).toBe(false)
  })

  it('extractOpeningClarificationSentence returns first sentence for early plan-top', async () => {
    const { extractOpeningClarificationSentence, planTopDisplayText } = await import(
      '../src/react/lib/message-row-visible-text.ts'
    )
    expect(extractOpeningClarificationSentence('好的，先激活 workspace 场景。接下来读文件')).toBe(
      '好的，先激活 workspace 场景。',
    )
    expect(
      planTopDisplayText('好的，先激活 workspace 场景。接下来读文件', false, {
        streamingPreview: true,
      }),
    ).toBe('好的，先激活 workspace 场景。')
  })

  it('first text treated as normal chunk (no plan-top) while reasoning streams before tools', async () => {
    const { buildAssistantBubbleDisplayPlan } = await import(
      '../src/react/lib/message-row-display-plan.ts'
    )
    const plan = buildAssistantBubbleDisplayPlan({
      row: {
        role: '_stream',
        text: '明白，这轮先验证文件工具链路。',
        streamTextPhase: 'pre_tools',
      },
      displaySegments: [
        { kind: 'reasoning', text: 'long internal reasoning…' },
        { kind: 'text', text: '明白，这轮先验证文件工具链路。' },
      ],
      tools: [{ id: 'find1', name: 'find', status: 'running' }],
      rawText: '明白，这轮先验证文件工具链路。',
      text: '明白，这轮先验证文件工具链路。',
      textTrimmed: true,
      reasoningPreview: 'long internal reasoning…',
      reasoningSegments: ['long internal reasoning…'],
      isStreaming: true,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: true,
      systemActivityLabel: '',
      streamThinkingLabel: '正在思考...',
      legacyHasTools: true,
      legacyShowBody: true,
      plainBodyRaw: '明白，这轮先验证文件工具链路。',
      plainShowThinkingCursor: false,
    })
    expect(plan.slots.some((s) => s.kind === 'plan-top')).toBe(false)
  })

  it('shouldSuppressLiveTailDuringPreToolReasoning always false (first body is normal text)', () => {
    expect(
      shouldSuppressLiveTailDuringPreToolReasoning({
        isStreaming: true,
        streamTextPhase: 'pre_tools',
        hasToolsInTurn: false,
        firstActivityChunkIndex: 0,
        hasReasoningStreamUi: true,
      }),
    ).toBe(false)
    expect(
      shouldSuppressLiveTailDuringPreToolReasoning({
        isStreaming: true,
        streamTextPhase: 'post_tools',
        hasToolsInTurn: true,
        firstActivityChunkIndex: 0,
        hasReasoningStreamUi: true,
      }),
    ).toBe(false)
  })

  it('displayChunksHaveReasoningPieces detects activity reasoning', () => {
    expect(
      displayChunksHaveReasoningPieces([
        { kind: 'activity', pieces: [{ kind: 'reasoning', text: 'a', segIndex: 0 }], startIndex: 0 },
      ]),
    ).toBe(true)
    expect(displayChunksHaveReasoningPieces([{ kind: 'text', text: 'x', segIndex: 0 }])).toBe(false)
  })

  it('pre-tools reasoning without plan-top (text treated normally)', async () => {
    const { buildAssistantBubbleDisplayPlan } = await import(
      '../src/react/lib/message-row-display-plan.ts'
    )
    const plan = buildAssistantBubbleDisplayPlan({
      row: { role: '_stream', text: '计划正文', streamTextPhase: 'pre_tools' },
      displaySegments: [
        { kind: 'reasoning', text: '首轮思考' },
        { kind: 'text', text: '计划正文' },
      ],
      tools: [],
      rawText: '计划正文',
      text: '计划正文',
      textTrimmed: true,
      reasoningPreview: '首轮思考',
      reasoningSegments: ['首轮思考'],
      isStreaming: true,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: false,
      systemActivityLabel: '',
      streamThinkingLabel: '正在思考...',
      legacyHasTools: false,
      legacyShowBody: false,
      plainBodyRaw: '计划正文',
      plainShowThinkingCursor: false,
    })
    expect(plan.slots.some((s) => s.kind === 'plan-top')).toBe(false)
    expect(plan.slots.some((s) => s.kind === 'live-tail')).toBe(true)
  })

  it('AG-UI open reasoning (no timeline segment) shows in Exploring while streaming', async () => {
    const { buildAssistantBubbleDisplayPlan } = await import(
      '../src/react/lib/message-row-display-plan.ts'
    )
    const plan = buildAssistantBubbleDisplayPlan({
      row: { role: '_stream', text: '', runId: 'run-1', streamTextPhase: 'pre_tools' },
      displaySegments: [],
      tools: [],
      rawText: '',
      text: '',
      textTrimmed: false,
      reasoningPreview: 'The user is asking me to confirm…',
      reasoningSegments: [],
      isStreaming: true,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: false,
      systemActivityLabel: '推理中',
      streamThinkingLabel: '推理中',
      legacyHasTools: false,
      legacyShowBody: false,
      plainBodyRaw: '',
      plainShowThinkingCursor: false,
      aguiTurn: null,
    })
    // 方案 B：流式时 thinking-wait 始终在气泡底部
    expect(plan.slots.some((s) => s.kind === 'thinking-wait')).toBe(true)
    expect(plan.slots[plan.slots.length - 1].kind).toBe('thinking-wait')
    expect(
      plan.slots.some(
        (s) =>
          s.kind === 'top-reasoning' && String(s.text).includes('The user is asking'),
      ),
    ).toBe(true)
  })

  it('keeps reasoning with tools inside single Exploring chunk', async () => {
    const { buildAssistantBubbleDisplayPlan } = await import(
      '../src/react/lib/message-row-display-plan.ts'
    )
    const plan = buildAssistantBubbleDisplayPlan({
      row: { role: '_stream', text: '第四轮走起', runId: 'run-1' },
      displaySegments: [
        { kind: 'reasoning', text: 'long reasoning' },
        { kind: 'text', text: '第四轮走起' },
        { kind: 'tools', ids: ['find1'] },
      ],
      tools: [{ id: 'find1', name: 'find', status: 'ok' }],
      rawText: '第四轮走起',
      text: '第四轮走起',
      textTrimmed: true,
      reasoningPreview: 'long reasoning',
      reasoningSegments: ['long reasoning'],
      isStreaming: true,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: true,
      systemActivityLabel: '',
      streamThinkingLabel: '正在思考...',
      legacyHasTools: true,
      legacyShowBody: true,
      plainBodyRaw: '第四轮走起',
      plainShowThinkingCursor: false,
      aguiTurn: { runId: 'run-1', threadId: 't1', finished: false },
    })
    expect(plan.slots.some((s) => s.kind === 'chunk')).toBe(true)
  })

  it('dedupes repeated plan-top paragraphs', async () => {
    const { planTopDisplayText } = await import('../src/react/lib/message-row-visible-text.ts')
    const dup = '第四轮走起！换新花样来测。\n\n第四轮走起！换新花样来测。'
    expect(planTopDisplayText(dup)).toBe('第四轮走起！换新花样来测。')
  })

  it('findPlanTopTextChunk picks text before first exploring tools batch', async () => {
    const { groupSegmentsForExploringDisplay, coalesceAdjacentActivityChunks } = await import(
      '../src/react/lib/exploring-activity-group.ts'
    )
    const planText = '好的，workspace 已激活！现在对文件工具进行冒烟测试。'
    const segments = [
      { kind: 'reasoning', text: 'think zh' },
      { kind: 'tools', ids: ['sc'] },
      { kind: 'reasoning', text: 'think en' },
      { kind: 'text', text: planText },
      { kind: 'tools', ids: ['find1'] },
    ]
    const tools = [
      { id: 'sc', name: 'scenario', status: 'ok' },
      { id: 'find1', name: 'find', status: 'running' },
    ]
    const chunks = coalesceAdjacentActivityChunks(
      groupSegmentsForExploringDisplay(segments, tools, true, true),
      true,
    )
    const hit = findPlanTopTextChunk({
      displayChunks: chunks,
      suppressPlanExecPromptNoise: false,
    })
    expect(hit?.text).toContain('workspace 已激活')
  })

  it('first text chunk after tools treated normally (no plan-top)', async () => {
    const { buildAssistantBubbleDisplayPlan } = await import(
      '../src/react/lib/message-row-display-plan.ts'
    )
    const planText = '好的，workspace 已激活！现在对文件工具进行冒烟测试。'
    const plan = buildAssistantBubbleDisplayPlan({
      row: { role: '_stream', text: '', streamTextPhase: 'post_tools' },
      displaySegments: [
        { kind: 'reasoning', text: 'think zh' },
        { kind: 'tools', ids: ['sc'] },
        { kind: 'reasoning', text: 'think en' },
        { kind: 'text', text: planText },
        { kind: 'tools', ids: ['find1'] },
      ],
      tools: [
        { id: 'sc', name: 'scenario', status: 'ok' },
        { id: 'find1', name: 'find', status: 'running' },
      ],
      rawText: '',
      text: '',
      textTrimmed: false,
      reasoningPreview: 'think en',
      reasoningSegments: ['think zh', 'think en'],
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
    expect(plan.slots.some((s) => s.kind === 'plan-top')).toBe(false)
    // 思考 + 工具 + 工具间正文统一收进单一 Exploring 折叠（chunk）
    expect(plan.slots.some((s) => s.kind === 'chunk')).toBe(true)
    expect(plan.slots.filter((s) => s.kind === 'top-reasoning')).toHaveLength(0)
  })
})

describe('message-row-display-plan', () => {
  it('suppresses top reasoning during streaming timeline with tools', async () => {
    const { buildAssistantBubbleDisplayPlan } = await import(
      '../src/react/lib/message-row-display-plan.ts'
    )
    const plan = buildAssistantBubbleDisplayPlan({
      row: { role: '_stream', text: '## 汇报', streamTextPhase: 'post_tools' },
      displaySegments: [
        { kind: 'tools', ids: ['t1'] },
        { kind: 'reasoning', text: 'thinking live' },
      ],
      tools: [{ id: 't1', name: 'terminal', status: 'ok' }],
      rawText: '## 汇报',
      text: '## 汇报',
      textTrimmed: true,
      reasoningPreview: 'thinking live',
      reasoningSegments: ['thinking live'],
      isStreaming: true,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: true,
      systemActivityLabel: '',
      streamThinkingLabel: '正在思考...',
      legacyHasTools: true,
      legacyShowBody: true,
      plainBodyRaw: '## 汇报',
      plainShowThinkingCursor: false,
    })
    expect(plan.slots.filter((s) => s.kind === 'reasoning-pending').length).toBe(0)
    // 工具 + 思考收进单一 Exploring 折叠（chunk），不再平铺 tool-row / top-reasoning
    expect(plan.slots.some((s) => s.kind === 'chunk')).toBe(true)
    expect(plan.slots.some((s) => s.kind === 'live-tail')).toBe(true)
  })

  it('does not duplicate reasoning already inside activity chunk', async () => {
    const { buildAssistantBubbleDisplayPlan, reasoningSegmentRenderedInChunks } = await import(
      '../src/react/lib/message-row-display-plan.ts'
    )
    const chunks = [
      {
        kind: 'activity',
        pieces: [
          { kind: 'tools', ids: ['t1'], segIndex: 0 },
          { kind: 'reasoning', text: 'after tools', segIndex: 1 },
        ],
        startIndex: 0,
      },
    ]
    expect(reasoningSegmentRenderedInChunks(chunks, 1)).toBe(true)

    const plan = buildAssistantBubbleDisplayPlan({
      row: { role: '_stream', text: '', streamTextPhase: 'post_tools' },
      displaySegments: [
        { kind: 'tools', ids: ['t1'] },
        { kind: 'reasoning', text: 'after tools' },
      ],
      tools: [{ id: 't1', name: 'read_file', status: 'ok' }],
      rawText: '',
      text: '',
      textTrimmed: false,
      reasoningPreview: 'after tools',
      reasoningSegments: ['after tools'],
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
  })

  it('shows live-tail instead of reasoning-pending when body text is already streaming', async () => {
    const { buildAssistantBubbleDisplayPlan } = await import(
      '../src/react/lib/message-row-display-plan.ts'
    )
    const plan = buildAssistantBubbleDisplayPlan({
      row: { role: '_stream', text: '## 汇报', streamTextPhase: 'post_tools' },
      displaySegments: [
        { kind: 'tools', ids: ['t1'] },
        { kind: 'reasoning', text: 'partial think' },
      ],
      tools: [{ id: 't1', name: 'terminal', status: 'ok' }],
      rawText: '## 汇报',
      text: '## 汇报',
      textTrimmed: true,
      reasoningPreview: 'partial think and more latest reasoning',
      reasoningSegments: ['partial think and more latest reasoning'],
      isStreaming: true,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: true,
      systemActivityLabel: '',
      streamThinkingLabel: '正在思考...',
      legacyHasTools: true,
      legacyShowBody: true,
      plainBodyRaw: '## 汇报',
      plainShowThinkingCursor: false,
    })
    expect(plan.slots.some((s) => s.kind === 'reasoning-pending')).toBe(false)
    expect(plan.slots.some((s) => s.kind === 'live-tail')).toBe(true)
  })

  it('streams extended reasoning inside Exploring when preview grows (no reasoning-pending)', async () => {
    const { buildAssistantBubbleDisplayPlan } = await import(
      '../src/react/lib/message-row-display-plan.ts'
    )
    const plan = buildAssistantBubbleDisplayPlan({
      row: { role: '_stream', text: '', streamTextPhase: 'post_tools' },
      displaySegments: [
        { kind: 'tools', ids: ['t1'] },
        { kind: 'reasoning', text: 'partial think' },
      ],
      tools: [{ id: 't1', name: 'terminal', status: 'ok' }],
      rawText: '',
      text: '',
      textTrimmed: false,
      reasoningPreview: 'partial think and more latest reasoning',
      reasoningSegments: ['partial think and more latest reasoning'],
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
    // 思考随工具收进 Exploring 折叠；流式 preview 增长体现在 fold 内最新 reasoning piece
    expect(plan.slots.some((s) => s.kind === 'chunk')).toBe(true)
  })
  })

  it('hides reasoning-pending when body live-tail is active (run f02ef685)', async () => {
    const { buildAssistantBubbleDisplayPlan } = await import(
      '../src/react/lib/message-row-display-plan.ts'
    )
    const plan = buildAssistantBubbleDisplayPlan({
      row: { role: '_stream', text: '好的，简单跑几个', streamTextPhase: 'post_tools' },
      displaySegments: [
        { kind: 'reasoning', text: 'plan' },
        { kind: 'tools', ids: ['t1'] },
        { kind: 'reasoning', text: 'long post-tool think '.repeat(20) },
      ],
      tools: [{ id: 't1', name: 'scenario', status: 'ok' }],
      rawText: '好的，简单跑几个',
      text: '好的，简单跑几个',
      textTrimmed: true,
      reasoningPreview: 'long post-tool think '.repeat(22),
      reasoningSegments: ['plan', 'long post-tool think '.repeat(22)],
      isStreaming: true,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: true,
      systemActivityLabel: '',
      streamThinkingLabel: '正在思考...',
      legacyHasTools: true,
      legacyShowBody: true,
      plainBodyRaw: '好的，简单跑几个',
      plainShowThinkingCursor: false,
    })
    expect(plan.slots.some((s) => s.kind === 'reasoning-pending')).toBe(false)
    expect(plan.slots.some((s) => s.kind === 'live-tail')).toBe(true)
  })

  it('hides reasoning-pending when visible tools are running after tools segment', async () => {
    const { buildAssistantBubbleDisplayPlan } = await import(
      '../src/react/lib/message-row-display-plan.ts'
    )
    const plan = buildAssistantBubbleDisplayPlan({
      row: { role: '_stream', text: '', streamTextPhase: 'post_tools' },
      displaySegments: [
        { kind: 'reasoning', text: 'plan' },
        { kind: 'tools', ids: ['t1'] },
        { kind: 'reasoning', text: 'still thinking' },
        { kind: 'text', text: '旁白' },
        { kind: 'tools', ids: ['t2'] },
      ],
      tools: [
        { id: 't1', name: 'scenario', status: 'ok' },
        { id: 't2', name: 'terminal', status: 'running' },
      ],
      rawText: '',
      text: '',
      textTrimmed: false,
      reasoningPreview: 'still thinking more',
      reasoningSegments: ['plan', 'still thinking more'],
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
  })

  it('isReasoningFullyRenderedInChunks requires preview not longer than piece', () => {
    const chunks = [
      {
        kind: 'activity',
        pieces: [{ kind: 'reasoning', text: 'short', segIndex: 1 }],
        startIndex: 0,
      },
    ]
    expect(isReasoningFullyRenderedInChunks('short', chunks, 1)).toBe(true)
    expect(isReasoningFullyRenderedInChunks('short but still growing', chunks, 1)).toBe(false)
  })

  it('uses single Exploring with all reasoning inside (log run-9c3192c34e4c layout)', async () => {
    const { buildAssistantBubbleDisplayPlan } = await import(
      '../src/react/lib/message-row-display-plan.ts'
    )
    const plan = buildAssistantBubbleDisplayPlan({
      row: { role: '_stream', text: '好，开始冒烟', runId: 'run-9c3192c34e4c' },
      displaySegments: [
        { kind: 'reasoning', text: '首轮分析 workspace' },
        { kind: 'tools', ids: ['sc'] },
        { kind: 'reasoning', text: '激活后再查入口' },
        { kind: 'text', text: '好，开始冒烟' },
        { kind: 'tools', ids: ['find1', 'rg1'] },
      ],
      tools: [
        { id: 'sc', name: 'scenario', status: 'ok' },
        { id: 'find1', name: 'find', status: 'ok' },
        { id: 'rg1', name: 'rg', status: 'ok' },
      ],
      rawText: '好，开始冒烟',
      text: '好，开始冒烟',
      textTrimmed: true,
      reasoningPreview: '激活后再查入口',
      reasoningSegments: ['首轮分析 workspace', '激活后再查入口'],
      isStreaming: false,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: true,
      systemActivityLabel: '',
      streamThinkingLabel: '正在思考...',
      legacyHasTools: true,
      legacyShowBody: true,
      plainBodyRaw: '好，开始冒烟',
      plainShowThinkingCursor: false,
      aguiTurn: { runId: 'run-9c3192c34e4c', threadId: 't1', finished: true },
    })
    // 全部思考 + 工具收进单一 Exploring 折叠；最终正文留外
    expect(plan.slots.filter((s) => s.kind === 'chunk')).toHaveLength(1)
    expect(plan.slots.some((s) => s.kind === 'plain-body' || s.kind === 'live-tail')).toBe(true)
    expect(plan.slots.filter((s) => s.kind === 'top-reasoning')).toHaveLength(0)
    expect(plan.slots.filter((s) => s.kind === 'tool-row')).toHaveLength(0)
  })

  it('does not show bottom live-tail when turn ends with tools and no final reply', async () => {
    const { buildAssistantBubbleDisplayPlan } = await import(
      '../src/react/lib/message-row-display-plan.ts'
    )
    const segments = [
      { kind: 'reasoning', text: 'thinking' },
      { kind: 'text', text: '开场白' },
      { kind: 'tools', ids: ['t1'] },
      { kind: 'text', text: '工具间旁白一' },
      { kind: 'tools', ids: ['t2'] },
      { kind: 'text', text: '工具间旁白二' },
      { kind: 'tools', ids: ['t3'] },
    ]
    const rawText = '开场白\n\n工具间旁白一\n\n工具间旁白二'
    const plan = buildAssistantBubbleDisplayPlan({
      row: { role: 'assistant', text: rawText },
      displaySegments: segments,
      tools: [
        { id: 't1', name: 'find', status: 'ok' },
        { id: 't2', name: 'read_file', status: 'ok' },
        { id: 't3', name: 'terminal', status: 'ok' },
      ],
      rawText,
      text: rawText,
      textTrimmed: true,
      reasoningPreview: '',
      reasoningSegments: ['thinking'],
      isStreaming: false,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: true,
      systemActivityLabel: '',
      streamThinkingLabel: '正在思考...',
      legacyHasTools: true,
      legacyShowBody: true,
      plainBodyRaw: rawText,
      plainShowThinkingCursor: false,
    })
    expect(plan.layout?.finalReplyChunkIndex).toBe(-1)
    expect(plan.slots.some((s) => s.kind === 'live-tail')).toBe(false)
  })

  it('keeps all reasoning inside single Exploring after run ends', async () => {
    const { buildAssistantBubbleDisplayPlan } = await import(
      '../src/react/lib/message-row-display-plan.ts'
    )
    const plan = buildAssistantBubbleDisplayPlan({
      row: { role: 'assistant', text: 'done' },
      displaySegments: [
        { kind: 'reasoning', text: 'think one' },
        { kind: 'tools', ids: ['a'] },
        { kind: 'reasoning', text: 'think two' },
        { kind: 'tools', ids: ['b'] },
      ],
      tools: [
        { id: 'a', name: 'find', status: 'ok' },
        { id: 'b', name: 'rg', status: 'ok' },
      ],
      rawText: 'done',
      text: 'done',
      textTrimmed: true,
      reasoningPreview: '',
      reasoningSegments: ['think one', 'think two'],
      isStreaming: false,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: true,
      systemActivityLabel: '',
      streamThinkingLabel: '正在思考...',
      legacyHasTools: true,
      legacyShowBody: true,
      plainBodyRaw: 'done',
      plainShowThinkingCursor: false,
    })
    expect(plan.slots.filter((s) => s.kind === 'top-reasoning')).toHaveLength(0)
    const exploring = plan.slots.find(
      (s) => s.kind === 'chunk' && s.chunk.kind === 'activity',
    )
    expect(exploring?.kind === 'chunk' && exploring.chunk.pieces.some(
      (p) => p.kind === 'reasoning' && String(p.text).includes('think one'),
    )).toBe(true)
    expect(exploring?.kind === 'chunk' && exploring.chunk.pieces.some(
      (p) => p.kind === 'reasoning' && String(p.text).includes('think two'),
    )).toBe(true)
  })
})

describe('tool-filter-id-resolve', () => {
  it('toolFilterIdAliases strips worker search suffix', () => {
    const id = 'call_abc123:search:0'
    expect(toolFilterIdAliases(id)).toContain('call_abc123')
    expect(toolFilterIdAliases(id)).toContain(id)
  })

  it('toolIdsMatchFilter links synthetic search id to parent', () => {
    expect(toolIdsMatchFilter('call_parent:search:0', 'call_parent')).toBe(true)
    expect(toolIdsMatchFilter('call_parent:search:0', 'call_parent:search:0')).toBe(true)
  })

  it('resolveToolByFilterId finds worker synthetic search row', () => {
    const parentId = 'call_worker_parent'
    const tools = [
      {
        id: parentId,
        tool_call_id: parentId,
        name: 'worker',
        input: {
          tasks: [{ action: 'search', query: 'foo', read_limit: 3 }],
        },
        status: 'running',
      },
    ]
    const expanded = expandToolsForFilterResolution(tools)
    const hit = resolveToolByFilterId(expanded, `${parentId}:search:0`)
    expect(hit).toBeTruthy()
    expect(String(hit.name || '')).toMatch(/search/i)
  })

  it('resolveToolByFilterId matches parent prefix for nested id', () => {
    const tools = [{ id: 'call_xyz', tool_call_id: 'call_xyz', name: 'terminal', status: 'ok' }]
    expect(resolveToolByFilterId(tools, 'call_xyz:session:0')).toBe(tools[0])
  })
})
