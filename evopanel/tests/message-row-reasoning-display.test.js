import { describe, expect, it } from 'vitest'
import {
  resolveReasoningDisplayPlan,
  shouldSuppressTopReasoningBlocks,
  splitActivityForInlineReasoning,
  groupActivityPiecesChronologically,
} from '../src/react/lib/message-row-reasoning-display.ts'
import { resolveActiveReasoningDisplayText, isReasoningPieceActivelyStreaming } from '../src/react/lib/message-row-reasoning-render.ts'

describe('message-row-reasoning-display', () => {
  it('shouldSuppressTopReasoningBlocks when timeline has reasoning (stream and history)', () => {
    expect(shouldSuppressTopReasoningBlocks(false, false, true, true)).toBe(true)
    expect(shouldSuppressTopReasoningBlocks(false, false, true, false)).toBe(true)
    expect(shouldSuppressTopReasoningBlocks(false, false, false, false)).toBe(false)
  })

  it('shouldSuppressTopReasoningBlocks during streaming with tools', () => {
    expect(shouldSuppressTopReasoningBlocks(false, true, false, true)).toBe(true)
    expect(shouldSuppressTopReasoningBlocks(true, false, false, true)).toBe(true)
    expect(shouldSuppressTopReasoningBlocks(false, true, false, false)).toBe(false)
  })

  it('resolveReasoningDisplayPlan suppresses top stack when timeline has reasoning', () => {
    const plan = resolveReasoningDisplayPlan({
      isStreaming: false,
      hasTimelineReasoning: true,
      hasVisibleToolsInTimeline: true,
      hasToolsSegmentInTimeline: true,
      hasToolsInTurnEarly: true,
      displaySegmentCount: 3,
    })
    expect(plan.showTopStack).toBe(false)
    expect(plan.useTimelineInterleave).toBe(true)
  })

  it('resolveReasoningDisplayPlan allows top stack for legacy preview-only rows', () => {
    const plan = resolveReasoningDisplayPlan({
      isStreaming: false,
      hasTimelineReasoning: false,
      hasVisibleToolsInTimeline: false,
      hasToolsSegmentInTimeline: false,
      hasToolsInTurnEarly: false,
      displaySegmentCount: 0,
    })
    expect(plan.showTopStack).toBe(true)
  })

  it('resolveReasoningDisplayPlan suppresses top stack during streaming when timeline exists', () => {
    const plan = resolveReasoningDisplayPlan({
      isStreaming: true,
      hasTimelineReasoning: false,
      hasVisibleToolsInTimeline: false,
      hasToolsSegmentInTimeline: false,
      hasToolsInTurnEarly: false,
      displaySegmentCount: 2,
    })
    expect(plan.showTopStack).toBe(false)
  })

  it('groupActivityPiecesChronologically keeps post-tool reasoning after fold', () => {
    const pieces = [
      { kind: 'reasoning', text: 'before', segIndex: 0 },
      { kind: 'tools', ids: ['t1'], segIndex: 1 },
      { kind: 'reasoning', text: 'after', segIndex: 2 },
    ]
    const groups = groupActivityPiecesChronologically(pieces)
    expect(groups.map((g) => g.kind)).toEqual(['reasoning', 'fold', 'reasoning'])
    expect(groups[2].kind === 'reasoning' && groups[2].piece.text).toBe('after')
  })

  it('splitActivityForInlineReasoning separates reasoning from fold content', () => {
    const pieces = [
      { kind: 'reasoning', text: 'think', segIndex: 0 },
      { kind: 'text', text: 'plan', segIndex: 1 },
      { kind: 'tools', ids: ['t1'], segIndex: 2 },
    ]
    const { reasoningPieces, foldPieces } = splitActivityForInlineReasoning(pieces)
    expect(reasoningPieces).toHaveLength(1)
    expect(foldPieces.map((p) => p.kind)).toEqual(['text', 'tools'])
  })

  it('resolveActiveReasoningDisplayText does not stack prior-round preview onto active piece', () => {
    const mergedPreview = 'round one\n\nround two streaming'
    expect(
      resolveActiveReasoningDisplayText('round one', mergedPreview, false),
    ).toBe('round one')
    expect(
      resolveActiveReasoningDisplayText('round two', mergedPreview, true),
    ).toBe('round two')
    expect(
      resolveActiveReasoningDisplayText('round two partial', 'round two streaming', true),
    ).toBe('round two partial')
    expect(
      resolveActiveReasoningDisplayText('round two', 'round two streaming delta', true),
    ).toBe('round two streaming delta')
  })

  it('isReasoningPieceActivelyStreaming only when timeline tail is reasoning', () => {
    expect(
      isReasoningPieceActivelyStreaming({
        isStreaming: true,
        pieceSegIndex: 0,
        lastReasoningSegIdx: 0,
        lastTimelineSegmentKind: 'reasoning',
      }),
    ).toBe(true)
    expect(
      isReasoningPieceActivelyStreaming({
        isStreaming: true,
        pieceSegIndex: 0,
        lastReasoningSegIdx: 0,
        lastTimelineSegmentKind: 'tools',
      }),
    ).toBe(false)
    expect(
      isReasoningPieceActivelyStreaming({
        isStreaming: true,
        pieceSegIndex: 0,
        lastReasoningSegIdx: 2,
        lastTimelineSegmentKind: 'reasoning',
      }),
    ).toBe(false)
    expect(
      isReasoningPieceActivelyStreaming({
        isStreaming: true,
        pieceSegIndex: 2,
        lastReasoningSegIdx: 2,
        lastTimelineSegmentKind: 'reasoning',
      }),
    ).toBe(true)
    // 上提到正文前的未闭合思考：时间线末尾仍是 tools，靠 open id 保持流式
    expect(
      isReasoningPieceActivelyStreaming({
        isStreaming: true,
        pieceSegIndex: 4,
        lastReasoningSegIdx: 4,
        lastTimelineSegmentKind: 'tools',
        pieceId: '__open_reasoning__',
      }),
    ).toBe(true)
  })
})
