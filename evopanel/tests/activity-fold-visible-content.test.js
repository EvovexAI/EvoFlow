import { describe, expect, it } from 'vitest'
import { activityFoldHasVisibleInnerContent } from '../src/react/lib/message-row-reasoning-render.ts'

describe('activityFoldHasVisibleInnerContent', () => {
  it('false when tools-only pieces have no resolvable tool rows', () => {
    expect(
      activityFoldHasVisibleInnerContent({
        activityPieces: [{ kind: 'tools', ids: ['missing-id'] }],
        tools: [{ id: 't1', name: 'find', status: 'ok' }],
        isStreaming: false,
        lastReasoningSegIdx: -1,
        streamTextPhase: 'post_tools',
        displaySegments: [{ kind: 'tools', ids: ['missing-id'] }],
        rawText: '',
      }),
    ).toBe(false)
  })

  it('true when tool piece resolves to visible tools', () => {
    expect(
      activityFoldHasVisibleInnerContent({
        activityPieces: [{ kind: 'tools', ids: ['t1'] }],
        tools: [{ id: 't1', name: 'find', status: 'ok' }],
        isStreaming: false,
        lastReasoningSegIdx: -1,
        streamTextPhase: 'post_tools',
        displaySegments: [{ kind: 'tools', ids: ['t1'] }],
        rawText: '',
      }),
    ).toBe(true)
  })

  it('false when reasoning is hidden as body duplicate', () => {
    const rawText = 'A'.repeat(80)
    expect(
      activityFoldHasVisibleInnerContent({
        activityPieces: [{ kind: 'reasoning', text: rawText, segIndex: 0 }],
        tools: [],
        isStreaming: true,
        lastReasoningSegIdx: 0,
        streamTextPhase: 'post_tools',
        displaySegments: [{ kind: 'reasoning', text: rawText }],
        rawText,
      }),
    ).toBe(false)
  })
})
