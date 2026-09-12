import { describe, expect, it } from 'vitest'
import { buildAssistantBubbleDisplayPlan } from '../src/react/lib/message-row-display-plan.ts'
import {
  buildDisplayTimeline,
  synthesizeBaseSegmentsWhenMissing,
} from '../src/react/lib/message-row-timeline.ts'
import { visibleAssistantText, visiblePreToolTimelineText } from '../src/react/lib/message-row-visible-text.ts'

function basePlanInput(overrides = {}) {
  return {
    row: { role: 'assistant', text: '' },
    displaySegments: [],
    tools: [],
    rawText: '',
    text: '',
    textTrimmed: false,
    reasoningPreview: '',
    reasoningSegments: [],
    isStreaming: false,
    interactiveToolApproval: false,
    suppressPlanExecPromptNoise: false,
    hasToolsInTurnEarly: false,
    systemActivityLabel: '',
    streamThinkingLabel: '',
    legacyHasTools: false,
    legacyShowBody: false,
    plainBodyRaw: '',
    plainShowThinkingCursor: false,
    ...overrides,
  }
}

describe('message-row-display-plan path convergence', () => {
  it('synthesizeBaseSegmentsWhenMissing builds reasoning then text', () => {
    const segs = synthesizeBaseSegmentsWhenMissing({
      segments: [],
      rawText: '总结正文',
      reasoningPreview: '内部思考',
    })
    expect(segs.map((s) => s.kind)).toEqual(['reasoning', 'text'])
  })

  it('buildDisplayTimeline synthesizes tools segment for tools-only history row', () => {
    const timeline = buildDisplayTimeline([], [{ id: 't1', name: 'read_file', status: 'ok' }])
    expect(timeline.some((s) => s.kind === 'tools')).toBe(true)
  })

  it('tools-only idle row uses timeline path (not legacy)', () => {
    const tools = [{ id: 't1', name: 'find', status: 'ok' }]
    const displaySegments = buildDisplayTimeline([], tools)
    const plan = buildAssistantBubbleDisplayPlan(
      basePlanInput({
        tools,
        displaySegments,
        legacyHasTools: true,
        hasToolsInTurnEarly: true,
      }),
    )
    expect(plan.path).toBe('timeline')
    expect(plan.slots.some((s) => s.kind === 'legacy-tools')).toBe(false)
  })

  it('text-only history without segments uses timeline path', () => {
    const rawText = '这是落库正文。'
    const displaySegments = buildDisplayTimeline([], [], { rawText })
    const plan = buildAssistantBubbleDisplayPlan(
      basePlanInput({
        row: { role: 'assistant', text: rawText },
        rawText,
        text: rawText,
        textTrimmed: true,
        displaySegments,
        legacyShowBody: true,
      }),
    )
    expect(plan.path).toBe('timeline')
    expect(plan.slots.some((s) => s.kind === 'legacy-body')).toBe(false)
  })

  it('streaming text-only turn still uses plain path', () => {
    // 无封存 text segment 的纯流式才走 plain；有 sealed text 会走 agui/timeline
    const plan = buildAssistantBubbleDisplayPlan(
      basePlanInput({
        row: { role: '_stream', text: '流式正文' },
        displaySegments: [],
        rawText: '流式正文',
        text: '流式正文',
        textTrimmed: true,
        plainBodyRaw: '流式正文',
        isStreaming: true,
      }),
    )
    expect(plan.path).toBe('plain')
  })

  it('streaming sealed text segment leaves plain path', () => {
    const plan = buildAssistantBubbleDisplayPlan(
      basePlanInput({
        row: { role: '_stream', text: '流式正文' },
        displaySegments: [{ kind: 'text', text: '流式正文' }],
        rawText: '流式正文',
        text: '流式正文',
        textTrimmed: true,
        isStreaming: true,
      }),
    )
    expect(plan.path).not.toBe('plain')
  })

  it('streaming body-before-reasoning race keeps thinking above body in timeline slots', () => {
    const displaySegments = [
      { kind: 'text', text: '你好世界' },
      { kind: 'reasoning', text: '先分析用户意图', id: 'rm1' },
    ]
    const plan = buildAssistantBubbleDisplayPlan(
      basePlanInput({
        row: { role: '_stream', text: '你好世界' },
        displaySegments,
        rawText: '你好世界',
        text: '你好世界',
        textTrimmed: true,
        reasoningPreview: '',
        isStreaming: true,
      }),
    )
    expect(plan.path).toBe('timeline')
    const chunkIdx = plan.slots.findIndex((s) => s.kind === 'chunk')
    const bodyIdx = plan.slots.findIndex(
      (s) => s.kind === 'plain-body' || s.kind === 'live-tail' || (s.kind === 'chunk' && plan.layout?.displayChunks[s.chunkIndex]?.kind === 'text'),
    )
    expect(chunkIdx).toBeGreaterThanOrEqual(0)
    expect(bodyIdx).toBeGreaterThanOrEqual(0)
    expect(chunkIdx).toBeLessThan(bodyIdx)
  })

  it('streaming turn with tools never uses plain path', () => {
    const tools = [{ id: 't1', name: 'find', status: 'running' }]
    const displaySegments = buildDisplayTimeline(
      [{ kind: 'text', text: '先查一下' }],
      tools,
    )
    const plan = buildAssistantBubbleDisplayPlan(
      basePlanInput({
        row: { role: '_stream', text: '先查一下' },
        tools,
        displaySegments,
        rawText: '先查一下',
        text: '先查一下',
        textTrimmed: true,
        hasToolsInTurnEarly: true,
        legacyHasTools: true,
        isStreaming: true,
      }),
    )
    expect(plan.path).not.toBe('plain')
    expect(plan.path).not.toBe('legacy')
  })

  it('pre-tool text stays visible before tool-row while streaming', () => {
    const bodyText = '好的，开始对工作区工具冒烟测试。'
    const tools = [{ id: 't1', name: 'write', status: 'running' }]
    const displaySegments = buildDisplayTimeline(
      [
        { kind: 'text', text: bodyText, seq: 1 },
        { kind: 'tools', ids: ['t1'], seq: 2 },
      ],
      tools,
    )
    const plan = buildAssistantBubbleDisplayPlan(
      basePlanInput({
        row: { role: '_stream', text: bodyText },
        tools,
        displaySegments,
        rawText: bodyText,
        text: bodyText,
        textTrimmed: true,
        hasToolsInTurnEarly: true,
        legacyHasTools: true,
        isStreaming: true,
        aguiTurn: { order: [], messages: new Map(), toolCalls: new Map() },
      }),
    )
    expect(plan.path).toBe('agui')
    const textSlot = plan.slots.find((s) => s.kind === 'plain-body' || s.kind === 'live-tail')
    const chunkIdx = plan.slots.findIndex((s) => s.kind === 'chunk')
    expect(textSlot).toBeTruthy()
    expect(plan.slots.indexOf(textSlot)).toBeLessThan(chunkIdx)
    expect(String(textSlot?.text || '')).toContain('冒烟测试')
  })

  it('empty shell row still uses legacy path', () => {
    const plan = buildAssistantBubbleDisplayPlan(basePlanInput())
    expect(plan.path).toBe('legacy')
  })

  it('persisted assistant with seq segments uses agui sequential path', () => {
    const displaySegments = [
      { kind: 'text', text: '计划', seq: 1 },
      { kind: 'tools', ids: ['t1'], seq: 2 },
      { kind: 'text', text: '总结', seq: 3 },
    ]
    const plan = buildAssistantBubbleDisplayPlan(
      basePlanInput({
        row: { role: 'assistant', text: '' },
        displaySegments,
        tools: [{ id: 't1', name: 'read', status: 'ok' }],
        isStreaming: false,
      }),
    )
    expect(plan.path).toBe('agui')
    expect(plan.slots.map((s) => s.kind)).toEqual(['plain-body', 'chunk', 'plain-body'])
  })
})

describe('buildAgUiSequentialPlan', () => {
  function finalizedInput(overrides = {}) {
    return {
      ...basePlanInput(),
      row: { role: 'assistant', text: '' },
      isStreaming: false,
      ...overrides,
    }
  }

  it('renders text then tools then body in seq order (no reasoning)', () => {
    const planText = '开始测试。'
    const bodyText = '最终总结'
    const plan = buildAssistantBubbleDisplayPlan(
      finalizedInput({
        displaySegments: [
          { kind: 'text', text: planText, seq: 1, blockKind: 'plan_text' },
          { kind: 'tools', ids: ['c1'], seq: 2, blockKind: 'tools' },
          { kind: 'text', text: bodyText, seq: 3, blockKind: 'body_text' },
        ],
        tools: [{ id: 'c1', name: 'grep', status: 'ok' }],
        rawText: bodyText,
        text: bodyText,
        textTrimmed: true,
        hasToolsInTurnEarly: true,
      }),
    )
    expect(plan.path).toBe('agui')
    expect(plan.slots.some((s) => s.kind === 'chunk')).toBe(true)
    const kinds = plan.slots.map((s) => s.kind)
    expect(kinds.indexOf('plain-body')).toBeLessThan(kinds.indexOf('chunk'))
    expect(kinds.indexOf('chunk')).toBeLessThan(kinds.lastIndexOf('plain-body'))
    expect(plan.slots.find((s) => s.kind === 'plain-body')?.text).toContain('开始测试')
  })

  it('interleaves reasoning between tool batches by seq', () => {
    const plan = buildAssistantBubbleDisplayPlan(
      finalizedInput({
        displaySegments: [
          { kind: 'tools', ids: ['c1'], seq: 2 },
          { kind: 'reasoning', text: 'think', seq: 3 },
          { kind: 'tools', ids: ['c2'], seq: 4 },
        ],
        tools: [
          { id: 'c1', name: 'read', status: 'ok' },
          { id: 'c2', name: 'grep', status: 'ok' },
        ],
        reasoningPreview: 'think',
        hasToolsInTurnEarly: true,
      }),
    )
    const kinds = plan.slots.map((s) => s.kind)
    expect(kinds).toEqual(['chunk'])
  })

  it('keeps multi-round body text between tool batches in seq order', () => {
    const plan = buildAssistantBubbleDisplayPlan(
      finalizedInput({
        displaySegments: [
          { kind: 'text', text: '开场计划', seq: 1, blockKind: 'plan_text' },
          { kind: 'tools', ids: ['c1'], seq: 2, blockKind: 'tools' },
          { kind: 'text', text: '第一轮说明', seq: 3, blockKind: 'body_text' },
          { kind: 'tools', ids: ['c2'], seq: 4, blockKind: 'tools' },
          { kind: 'text', text: '第二轮说明', seq: 5, blockKind: 'body_text' },
        ],
        tools: [
          { id: 'c1', name: 'write', status: 'ok' },
          { id: 'c2', name: 'read', status: 'ok' },
        ],
        hasToolsInTurnEarly: true,
      }),
    )
    expect(plan.path).toBe('agui')
    expect(plan.slots.some((s) => s.kind === 'chunk')).toBe(true)
    const bodySlots = plan.slots.filter((s) => s.kind === 'plain-body')
    expect(bodySlots.length).toBe(2)
    expect(String(bodySlots[0]?.text || '')).toContain('开场计划')
    expect(String(bodySlots[1]?.text || '')).toContain('第二轮说明')
    // 工具间旁白 '第一轮说明' 收进 Exploring 折叠，不出现在外层 plain-body
    expect(bodySlots.some((s) => String(s.text || '').includes('第一轮说明'))).toBe(false)
    const chunkIdx = plan.slots.findIndex((s) => s.kind === 'chunk')
    expect(plan.slots.indexOf(bodySlots[0])).toBeLessThan(chunkIdx)
    expect(chunkIdx).toBeLessThan(plan.slots.indexOf(bodySlots[1]))
  })

  it('streaming duplicate wire seq still renders text-tools-text strictly in order', () => {
    const plan = buildAssistantBubbleDisplayPlan(
      basePlanInput({
        row: { role: '_stream', text: '第二轮说明' },
        isStreaming: true,
        aguiTurn: { order: [], messages: new Map(), toolCalls: new Map() },
        displaySegments: [
          { kind: 'text', text: '开场计划', seq: 1 },
          { kind: 'tools', ids: ['c1'], seq: 2 },
          { kind: 'text', text: '第一轮说明', seq: 3 },
          { kind: 'tools', ids: ['c2'], seq: 2 },
          { kind: 'text', text: '第二轮说明', seq: 4 },
        ],
        tools: [
          { id: 'c1', name: 'write', status: 'ok' },
          { id: 'c2', name: 'read', status: 'running' },
        ],
        rawText: '第二轮说明',
        text: '第二轮说明',
        hasToolsInTurnEarly: true,
      }),
    )
    expect(plan.path).toBe('agui')
    const kinds = plan.slots.map((s) => s.kind)
    expect(kinds[0]).toBe('plain-body')
    expect(kinds).toContain('chunk')
    // 正文已在 segments 中：不应再挂累计 rawText 的 live-tail
    expect(kinds).not.toContain('live-tail')
    expect(String(plan.slots.find((s) => s.kind === 'plain-body')?.text || '')).toContain('开场计划')
  })

  it('streaming multi-body + cumulative rawText does not dump all bodies in live-tail', () => {
    const body1 = '第一轮说明'
    const body2 = '第二轮说明'
    const plan = buildAssistantBubbleDisplayPlan(
      basePlanInput({
        row: { role: '_stream', text: `${body1}\n\n${body2}` },
        isStreaming: true,
        aguiTurn: { order: [], messages: new Map(), toolCalls: new Map() },
        displaySegments: [
          { kind: 'text', text: '开场计划', seq: 1, blockKind: 'plan_text' },
          { kind: 'tools', ids: ['c1'], seq: 2, blockKind: 'tools' },
          { kind: 'text', text: body1, seq: 3, blockKind: 'body_text' },
          { kind: 'tools', ids: ['c2'], seq: 4, blockKind: 'tools' },
          { kind: 'text', text: body2, seq: 5, blockKind: 'body_text' },
        ],
        tools: [
          { id: 'c1', name: 'write', status: 'ok' },
          { id: 'c2', name: 'read', status: 'running' },
        ],
        // 刷新后续流常见：DB 把各段正文拼成一份 rawText
        rawText: `开场计划\n\n${body1}\n\n${body2}`,
        text: `开场计划\n\n${body1}\n\n${body2}`,
        hasToolsInTurnEarly: true,
      }),
    )
    expect(plan.path).toBe('agui')
    const liveTails = plan.slots.filter((s) => s.kind === 'live-tail')
    for (const slot of liveTails) {
      const t = String(slot.text || '')
      expect(t.includes('开场计划')).toBe(false)
      expect(t.includes(body1)).toBe(false)
    }
    const joinedBodies = plan.slots
      .filter((s) => s.kind === 'plain-body' || s.kind === 'live-tail')
      .map((s) => String(s.text || ''))
      .join('\n')
    // 开场计划只应出现一次（plain-body），不应再被 live-tail 整段复读
    expect(joinedBodies.split('开场计划').length - 1).toBe(1)
  })

  it('REPRO: consecutive inter-tool bodies must not appear in exploring AND live-tail', () => {
    const body1 = '先看一下目录结构。'
    const body2 = '接下来我会继续检查配置文件。'
    const segs = [
      { kind: 'tools', ids: ['a'], seq: 1 },
      { kind: 'text', text: body1, seq: 2 },
      { kind: 'text', text: body2, seq: 3 },
    ]
    const tools = [{ id: 'a', name: 'grep', status: 'ok' }]
    const plan = buildAssistantBubbleDisplayPlan(
      basePlanInput({
        row: { role: '_stream', text: body2, streamTailDedupeSegments: segs },
        isStreaming: true,
        aguiTurn: { order: [], messages: new Map(), toolCalls: new Map() },
        displaySegments: segs,
        tools,
        rawText: body2,
        text: body2,
        textTrimmed: true,
        hasToolsInTurnEarly: true,
      }),
    )
    const act = plan.slots.find((s) => s.kind === 'chunk' && s.chunk?.kind === 'activity')
    const innerTexts = (act?.chunk?.pieces || [])
      .filter((p) => p.kind === 'text')
      .map((p) => String(p.text || ''))
    const outer = plan.slots
      .filter((s) => s.kind === 'live-tail' || s.kind === 'plain-body')
      .map((s) => String(s.text || ''))
    const inInner = innerTexts.some((t) => t.includes(body2))
    const inOuter = outer.some((t) => t.includes(body2))
    // eslint-disable-next-line no-console
    console.log('REPRO consecutive', { inInner, inOuter, innerTexts, outer, livePreview: plan.layout?.liveTailPreviewText, kinds: plan.slots.map((s) => s.kind) })
    expect(inInner && inOuter).toBe(false)
  })

  it('REPRO: cumulative rawText with absorbed bodies', () => {
    const body1 = '先看一下目录结构。'
    const body2 = '接下来我会继续检查配置文件。'
    const segs = [
      { kind: 'tools', ids: ['a'], seq: 1 },
      { kind: 'text', text: body1, seq: 2 },
      { kind: 'text', text: body2, seq: 3 },
    ]
    const cum = `${body1}\n\n${body2}`
    const tools = [{ id: 'a', name: 'grep', status: 'ok' }]
    const plan = buildAssistantBubbleDisplayPlan(
      basePlanInput({
        row: { role: '_stream', text: cum, streamTailDedupeSegments: segs },
        isStreaming: true,
        aguiTurn: { order: [], messages: new Map(), toolCalls: new Map() },
        displaySegments: segs,
        tools,
        rawText: cum,
        text: cum,
        textTrimmed: true,
        hasToolsInTurnEarly: true,
      }),
    )
    const act = plan.slots.find((s) => s.kind === 'chunk' && s.chunk?.kind === 'activity')
    const innerTexts = (act?.chunk?.pieces || [])
      .filter((p) => p.kind === 'text')
      .map((p) => String(p.text || ''))
    const outer = plan.slots
      .filter((s) => s.kind === 'live-tail' || s.kind === 'plain-body')
      .map((s) => String(s.text || ''))
    const inInner = innerTexts.some((t) => t.includes(body2))
    const inOuter = outer.some((t) => t.includes(body2))
    // eslint-disable-next-line no-console
    console.log('REPRO cum', { inInner, inOuter, innerTexts, outer, livePreview: plan.layout?.liveTailPreviewText })
    expect(inInner && inOuter).toBe(false)
  })

  it('REPRO: streamTailDedupeSegments lags behind displaySegments open text', () => {
    const body = '第一轮结果收到了，继续查下一处。'
    const closedOnly = [{ kind: 'tools', ids: ['a'], seq: 1 }]
    const withOpen = [
      { kind: 'tools', ids: ['a'], seq: 1 },
      { kind: 'text', text: body, seq: 2 },
    ]
    const tools = [{ id: 'a', name: 'grep', status: 'ok' }]
    const plan = buildAssistantBubbleDisplayPlan(
      basePlanInput({
        row: { role: '_stream', text: body, streamTailDedupeSegments: closedOnly },
        isStreaming: true,
        aguiTurn: { order: [], messages: new Map(), toolCalls: new Map() },
        displaySegments: withOpen,
        tools,
        rawText: body,
        text: body,
        textTrimmed: true,
        hasToolsInTurnEarly: true,
      }),
    )
    const act = plan.slots.find((s) => s.kind === 'chunk' && s.chunk?.kind === 'activity')
    const innerTexts = (act?.chunk?.pieces || [])
      .filter((p) => p.kind === 'text')
      .map((p) => String(p.text || ''))
    const outer = plan.slots
      .filter((s) => s.kind === 'live-tail' || s.kind === 'plain-body')
      .map((s) => String(s.text || ''))
    const inInner = innerTexts.some((t) => t.includes('继续查'))
    const inOuter = outer.some((t) => t.includes('继续查'))
    // eslint-disable-next-line no-console
    console.log('REPRO lag dedupe', { inInner, inOuter, innerTexts, outer, livePreview: plan.layout?.liveTailPreviewText })
    // Fixed: open text already in Exploring must not also appear as live-tail
    expect(inInner && inOuter).toBe(false)
  })

  it('history: plan+tools then wrap-up shows wrap-up after Exploring (not only plan)', async () => {
    const { messagesToDisplayRows } = await import('../src/lib/chat-normalize.js')
    const plan = '好的，我来将这个会话思维导图数据添加到知识库。\n\n'
    const body = '本轮值班开始。\n\n**结论**：本轮值班结束。'
    const rows = messagesToDisplayRows([
      {
        role: 'assistant',
        type: 'ai',
        content_json: {
          content: plan,
          tool_calls: [
            {
              name: 'platform',
              args: { action: 'knowledge.create' },
              id: 'call_1',
              type: 'tool_call',
            },
          ],
        },
        id: 'a1',
        run_id: 'run1',
        seq: 1719,
      },
      {
        role: 'tool',
        type: 'tool',
        content_json: { content: JSON.stringify({ ok: true, action: 'knowledge.create' }) },
        tool_call_id: 'call_1',
        name: 'platform',
        id: 't1',
        run_id: 'run1',
        seq: 1720,
      },
      {
        role: 'assistant',
        type: 'ai',
        content_json: { content: body },
        id: 'a2',
        run_id: 'run1',
        seq: 1721,
      },
    ])
    const row = rows.find((r) => r.role === 'assistant')
    expect(row).toBeTruthy()
    expect(String(row.text || '')).toContain('本轮值班结束')
    const displaySegments = row.segments || []
    const tools = row.tools || []
    const rawText = String(row.text || '')
    const bubble = buildAssistantBubbleDisplayPlan(
      basePlanInput({
        row,
        displaySegments,
        tools,
        rawText,
        text: rawText,
        textTrimmed: !!rawText.trim(),
        hasToolsInTurnEarly: tools.length > 0,
        legacyHasTools: tools.length > 0,
        legacyShowBody: true,
        plainBodyRaw: rawText,
      }),
    )
    const outerBodies = bubble.slots
      .filter((s) => s.kind === 'plain-body' || s.kind === 'live-tail')
      .map((s) => String(s.text || ''))
    const chunkTexts = bubble.slots
      .filter((s) => s.kind === 'chunk' && s.chunk?.kind === 'text')
      .map((s) => String(s.chunk?.text || ''))
    const visible = [...outerBodies, ...chunkTexts].join('\n')
    // eslint-disable-next-line no-console
    console.log('duty wrap-up slots', {
      path: bubble.path,
      segs: displaySegments.map((s) => ({
        kind: s.kind,
        text: String(s.text || '').slice(0, 40),
        ids: s.ids,
      })),
      slots: bubble.slots.map((s) => ({
        kind: s.kind,
        text: String(s.text || s.chunk?.text || '').slice(0, 60),
        chunk: s.chunk?.kind,
      })),
      outerBodies,
      chunkTexts,
    })
    expect(visible).toContain('本轮值班结束')
    expect(visible).toContain('知识库')
  })
})
