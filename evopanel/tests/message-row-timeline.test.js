import { describe, expect, it } from 'vitest'
import { buildDisplayTimeline, shouldUsePlainStreamPath, synthesizeBaseSegmentsWhenMissing } from '../src/react/lib/message-row-timeline.ts'

describe('message-row-timeline', () => {
  it('synthesizeBaseSegmentsWhenMissing returns empty when no content', () => {
    expect(synthesizeBaseSegmentsWhenMissing({ segments: [] })).toEqual([])
  })

  it('buildDisplayTimeline synthesizes text segment from rawText', () => {
    const timeline = buildDisplayTimeline([], [], { rawText: 'hello from db' })
    expect(timeline.some((s) => s.kind === 'text' && s.text === 'hello from db')).toBe(true)
  })

  it('buildDisplayTimeline inserts orphan tool ids into segments', () => {
    const tools = [{ id: 't1', name: 'read_file' }]
    const timeline = buildDisplayTimeline([{ kind: 'text', text: 'hello' }], tools)
    expect(timeline.some((s) => s.kind === 'tools')).toBe(true)
    const toolsSeg = timeline.find((s) => s.kind === 'tools')
    expect(toolsSeg?.ids).toContain('t1')
  })

  it('buildDisplayTimeline skips orphan tool insertion when segments have wire seq', () => {
    const tools = [
      { id: 't1', name: 'write' },
      { id: 't2', name: 'read' },
      { id: 't3', name: 'grep' },
    ]
    const timeline = buildDisplayTimeline(
      [
        { kind: 'text', text: 'plan', seq: 1 },
        { kind: 'tools', ids: ['t1'], seq: 2 },
        { kind: 'text', text: 'body', seq: 3 },
      ],
      tools,
    )
    expect(timeline).toHaveLength(3)
    expect(timeline.filter((s) => s.kind === 'tools')).toHaveLength(1)
  })

  it('shouldUsePlainStreamPath only for streaming text-only turns', () => {
    expect(
      shouldUsePlainStreamPath({
        isStreaming: true,
        hasToolsInTurnEarly: false,
        displaySegments: [{ kind: 'text', text: 'hi' }],
      }),
    ).toBe(true)
    expect(
      shouldUsePlainStreamPath({
        isStreaming: false,
        hasToolsInTurnEarly: false,
        displaySegments: [{ kind: 'text', text: 'hi' }],
      }),
    ).toBe(false)
    expect(
      shouldUsePlainStreamPath({
        isStreaming: true,
        hasToolsInTurnEarly: true,
        displaySegments: [{ kind: 'text', text: 'hi' }],
      }),
    ).toBe(false)
    expect(
      shouldUsePlainStreamPath({
        isStreaming: true,
        hasToolsInTurnEarly: false,
        displaySegments: [{ kind: 'reasoning', text: 'think' }],
      }),
    ).toBe(false)
  })
})
