import { describe, it, expect } from 'vitest'
import { buildAssistantBubbleDisplayPlan } from '../src/react/lib/message-row-display-plan.ts'
import { streamLiveTailForDisplay } from '../src/lib/chat-normalize.js'
import { isInterExploringTextSegment, groupSegmentsForExploringDisplay } from '../src/react/lib/exploring-activity-group.ts'

function slotSummary(plan) {
  return plan.slots.map((s) => {
    if (s.kind === 'chunk' && s.chunk?.kind === 'activity') {
      return {
        kind: 'chunk/activity',
        pieces: s.chunk.pieces.map((p) =>
          p.kind === 'text' ? `text:${p.text}` : p.kind === 'tools' ? `tools:${p.ids.join(',')}` : p.kind,
        ),
      }
    }
    if (s.kind === 'chunk') return { kind: `chunk/${s.chunk?.kind}`, text: s.chunk?.text }
    return { kind: s.kind, text: s.text, label: s.label }
  })
}

describe('repro streaming body in exploring AND live-tail', () => {
  const tools = [{ id: 'a', name: 'grep', status: 'ok' }]

  it('case: absorbed inter-tool narration + equal rawText', () => {
    const body = '第一轮结果收到了，继续查下一处。'
    const segs = [
      { kind: 'tools', ids: ['a'], seq: 1 },
      { kind: 'text', text: body, seq: 2 },
    ]
    expect(isInterExploringTextSegment(segs, 1, tools, true, true)).toBe(true)
    const plan = buildAssistantBubbleDisplayPlan({
      row: { role: '_stream', text: body, streamTailDedupeSegments: segs },
      displaySegments: segs,
      tools,
      rawText: body,
      text: body,
      textTrimmed: true,
      reasoningPreview: '',
      reasoningSegments: [],
      isStreaming: true,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: true,
      systemActivityLabel: '',
      streamThinkingLabel: '思考中',
      legacyHasTools: true,
      legacyShowBody: true,
      plainBodyRaw: body,
      plainShowThinkingCursor: false,
      aguiTurn: { order: [], messages: new Map(), toolCalls: new Map() },
    })
    console.log('case1', JSON.stringify(slotSummary(plan), null, 2))
    console.log('liveTailPreview', plan.layout?.liveTailPreviewText)
    const live = plan.slots.filter((s) => s.kind === 'live-tail')
    const act = plan.slots.find((s) => s.kind === 'chunk' && s.chunk?.kind === 'activity')
    const innerTexts = (act?.chunk?.pieces || []).filter((p) => p.kind === 'text').map((p) => p.text)
    // bug if both
    expect(innerTexts.some((t) => String(t).includes('继续查'))).toBe(true)
    expect(live.length).toBe(0)
  })

  it('case: two consecutive bodies, open=latest', () => {
    const body1 = '先看一下目录结构。'
    const body2 = '接下来我会继续检查配置文件。'
    const segs = [
      { kind: 'tools', ids: ['a'], seq: 1 },
      { kind: 'text', text: body1, seq: 2 },
      { kind: 'text', text: body2, seq: 3 },
    ]
    console.log(
      'inter1',
      isInterExploringTextSegment(segs, 1, tools, true, true),
      'inter2',
      isInterExploringTextSegment(segs, 2, tools, true, true),
    )
    console.log('chunks', groupSegmentsForExploringDisplay(segs, tools, true, true))
    console.log('streamLiveTail', streamLiveTailForDisplay(segs, body2))
    const plan = buildAssistantBubbleDisplayPlan({
      row: { role: '_stream', text: body2, streamTailDedupeSegments: segs },
      displaySegments: segs,
      tools,
      rawText: body2,
      text: body2,
      textTrimmed: true,
      reasoningPreview: '',
      reasoningSegments: [],
      isStreaming: true,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: true,
      systemActivityLabel: '',
      streamThinkingLabel: '思考中',
      legacyHasTools: true,
      legacyShowBody: true,
      plainBodyRaw: body2,
      plainShowThinkingCursor: false,
      aguiTurn: { order: [], messages: new Map(), toolCalls: new Map() },
    })
    console.log('case2', JSON.stringify(slotSummary(plan), null, 2))
    const live = plan.slots.filter((s) => s.kind === 'live-tail')
    const act = plan.slots.find((s) => s.kind === 'chunk' && s.chunk?.kind === 'activity')
    const innerTexts = (act?.chunk?.pieces || []).filter((p) => p.kind === 'text').map((p) => p.text)
    const outerBodies = plan.slots
      .filter((s) => s.kind === 'live-tail' || s.kind === 'plain-body')
      .map((s) => s.text)
    console.log({ innerTexts, outerBodies, liveTailPreview: plan.layout?.liveTailPreviewText })
    // Detect duplicate of latest body
    const latestInInner = innerTexts.some((t) => String(t).includes(body2))
    const latestInOuter = outerBodies.some((t) => String(t).includes(body2))
    expect(latestInInner && latestInOuter).toBe(false)
  })

  it('case: cumulative rawText', () => {
    const body1 = '先看一下目录结构。'
    const body2 = '接下来我会继续检查配置文件。'
    const segs = [
      { kind: 'tools', ids: ['a'], seq: 1 },
      { kind: 'text', text: body1, seq: 2 },
      { kind: 'text', text: body2, seq: 3 },
    ]
    const cum = `${body1}\n\n${body2}`
    console.log('streamLiveTail cum', JSON.stringify(streamLiveTailForDisplay(segs, cum)))
    const plan = buildAssistantBubbleDisplayPlan({
      row: { role: '_stream', text: cum, streamTailDedupeSegments: segs },
      displaySegments: segs,
      tools,
      rawText: cum,
      text: cum,
      textTrimmed: true,
      reasoningPreview: '',
      reasoningSegments: [],
      isStreaming: true,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: true,
      systemActivityLabel: '',
      streamThinkingLabel: '思考中',
      legacyHasTools: true,
      legacyShowBody: true,
      plainBodyRaw: cum,
      plainShowThinkingCursor: false,
      aguiTurn: { order: [], messages: new Map(), toolCalls: new Map() },
    })
    console.log('case3', JSON.stringify(slotSummary(plan), null, 2))
    const live = plan.slots.filter((s) => s.kind === 'live-tail')
    const act = plan.slots.find((s) => s.kind === 'chunk' && s.chunk?.kind === 'activity')
    const innerTexts = (act?.chunk?.pieces || []).filter((p) => p.kind === 'text').map((p) => p.text)
    const latestInInner = innerTexts.some((t) => String(t).includes(body2))
    const latestInOuter = live.some((s) => String(s.text).includes(body2))
    console.log({ latestInInner, latestInOuter, live: live.map((s) => s.text) })
    expect(latestInInner && latestInOuter).toBe(false)
  })

  it('case: text NOT absorbed (final-like) still streaming', () => {
    const body = '## 总结\n\n分析完成，建议如下：\n\n1. a\n2. b\n3. c\n\n因此可以继续。'
    const segs = [
      { kind: 'tools', ids: ['a'], seq: 1 },
      { kind: 'text', text: body, seq: 2 },
    ]
    console.log('inter', isInterExploringTextSegment(segs, 1, tools, true, true))
    const plan = buildAssistantBubbleDisplayPlan({
      row: { role: '_stream', text: body, streamTailDedupeSegments: segs },
      displaySegments: segs,
      tools,
      rawText: body,
      text: body,
      textTrimmed: true,
      reasoningPreview: '',
      reasoningSegments: [],
      isStreaming: true,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: true,
      systemActivityLabel: '',
      streamThinkingLabel: '思考中',
      legacyHasTools: true,
      legacyShowBody: true,
      plainBodyRaw: body,
      plainShowThinkingCursor: false,
      aguiTurn: { order: [], messages: new Map(), toolCalls: new Map() },
    })
    console.log('case4', JSON.stringify(slotSummary(plan), null, 2))
  })

  it('case: open text in exploring but rawText NOT in streamTailDedupe (dedupe missing open)', () => {
    const body = '第一轮结果收到了，继续查下一处。'
    const closedOnly = [{ kind: 'tools', ids: ['a'], seq: 1 }]
    const withOpen = [
      { kind: 'tools', ids: ['a'], seq: 1 },
      { kind: 'text', text: body, seq: 2 },
    ]
    console.log('streamLiveTail mismatch', JSON.stringify(streamLiveTailForDisplay(closedOnly, body)))
    const plan = buildAssistantBubbleDisplayPlan({
      row: { role: '_stream', text: body, streamTailDedupeSegments: closedOnly },
      displaySegments: withOpen,
      tools,
      rawText: body,
      text: body,
      textTrimmed: true,
      reasoningPreview: '',
      reasoningSegments: [],
      isStreaming: true,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: true,
      systemActivityLabel: '',
      streamThinkingLabel: '思考中',
      legacyHasTools: true,
      legacyShowBody: true,
      plainBodyRaw: body,
      plainShowThinkingCursor: false,
      aguiTurn: { order: [], messages: new Map(), toolCalls: new Map() },
    })
    console.log('case5', JSON.stringify(slotSummary(plan), null, 2))
    const live = plan.slots.filter((s) => s.kind === 'live-tail')
    const act = plan.slots.find((s) => s.kind === 'chunk' && s.chunk?.kind === 'activity')
    const innerTexts = (act?.chunk?.pieces || []).filter((p) => p.kind === 'text').map((p) => p.text)
    const latestInInner = innerTexts.some((t) => String(t).includes('继续查'))
    const latestInOuter = live.some((s) => String(s.text).includes('继续查'))
    console.log({ latestInInner, latestInOuter })
    // This is the bug shape
    expect(latestInInner && latestInOuter).toBe(true)
  })
})
