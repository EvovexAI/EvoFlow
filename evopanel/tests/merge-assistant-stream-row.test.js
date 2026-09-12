import { describe, expect, it } from 'vitest'
import {
  mergeAssistantRowWithStreamRow,
  mergeStreamSnapIntoAssistantRow,
  assistantRowAcceptsStreamContinuation,
} from '../src/react/lib/merge-assistant-stream-row.ts'

describe('mergeAssistantRowWithStreamRow', () => {
  it('merges text-only assistant with stream delta without duplicating prefix', () => {
    const merged = mergeAssistantRowWithStreamRow(
      { role: 'assistant', text: 'Hello', timestamp: 1 },
      { role: '_stream', text: ' world', timestamp: 2 },
    )
    expect(merged.role).toBe('assistant')
    expect(merged.text).toBe('Hello world')
  })

  it('concatenates segment timelines and tools', () => {
    const merged = mergeAssistantRowWithStreamRow(
      {
        role: 'assistant',
        text: 'plan',
        segments: [{ kind: 'text', text: 'plan', segIndex: 0 }],
        tools: [{ id: 't1', name: 'search' }],
        timestamp: 1,
      },
      {
        role: '_stream',
        text: 'answer',
        segments: [{ kind: 'text', text: 'answer', segIndex: 1 }],
        tools: [{ id: 't2', name: 'read' }],
        systemActivity: '推理中',
        timestamp: 2,
      },
    )
    expect(merged.segments).toHaveLength(2)
    expect(merged.tools).toHaveLength(2)
    expect(merged.systemActivity).toBe('推理中')
  })

  it('does not merge completed assistant with a new stream bubble', () => {
    expect(
      assistantRowAcceptsStreamContinuation({
        role: 'assistant',
        text: 'done',
        durationStr: '1.2s',
        tokenStr: '100',
      }),
    ).toBe(false)
  })

  it('merges completed assistant when hosted goal continues same run', () => {
    expect(
      assistantRowAcceptsStreamContinuation(
        {
          role: 'assistant',
          text: 'interim progress',
          durationStr: '1.2s',
          tokenStr: '100',
          runId: 'run-a',
        },
        'run-a',
        { hostedGoalSameRun: true },
      ),
    ).toBe(true)
  })

  it('allows merge for incompleteStream even when replay starts a new runId', () => {
    expect(
      assistantRowAcceptsStreamContinuation({
        role: 'assistant',
        text: 'partial',
        incompleteStream: true,
        runId: 'run-a',
      }, 'run-a'),
    ).toBe(true)
    // client_stream_replay after tool approval uses a fresh run id
    expect(
      assistantRowAcceptsStreamContinuation({
        role: 'assistant',
        text: 'partial',
        incompleteStream: true,
        runId: 'run-a',
      }, 'run-b'),
    ).toBe(true)
  })

  it('concatenates tools/segments when incomplete assistant continues with a new stream', () => {
    const merged = mergeAssistantRowWithStreamRow(
      {
        role: 'assistant',
        text: '',
        incompleteStream: true,
        segments: [
          { kind: 'text', text: 'plan', segIndex: 0 },
          { kind: 'tools', ids: ['w1'], segIndex: 1 },
        ],
        tools: [{ id: 'w1', name: 'write' }],
        runId: 'run-a',
        timestamp: 1,
      },
      {
        role: '_stream',
        text: 'done',
        segments: [
          { kind: 'tools', ids: ['r1'], segIndex: 0 },
          { kind: 'text', text: 'done', segIndex: 1 },
        ],
        tools: [{ id: 'r1', name: 'read' }],
        runId: 'run-b',
        timestamp: 2,
      },
    )
    expect(merged.tools?.map((t) => t.id)).toEqual(['w1', 'r1'])
    expect(merged.segments?.map((s) => s.kind)).toEqual(['text', 'tools', 'tools', 'text'])
  })

  it('does not drop earlier tools when stream prefix omits a middle tool id', () => {
    const merged = mergeAssistantRowWithStreamRow(
      {
        role: 'assistant',
        text: '',
        incompleteStream: true,
        segments: [
          { kind: 'tools', ids: ['w1'], segIndex: 0 },
          { kind: 'tools', ids: ['r1'], segIndex: 1 },
        ],
        tools: [
          { id: 'w1', name: 'write' },
          { id: 'r1', name: 'read' },
        ],
        timestamp: 1,
      },
      {
        role: '_stream',
        text: '',
        // Looks like a longer timeline but skipped read — must concat, not replace
        segments: [
          { kind: 'tools', ids: ['w1'], segIndex: 0 },
          { kind: 'tools', ids: ['d1'], segIndex: 1 },
        ],
        tools: [
          { id: 'w1', name: 'write' },
          { id: 'd1', name: 'delete' },
        ],
        aguiTurn: { runId: 'run-x', finished: false },
        timestamp: 2,
      },
    )
    expect(merged.tools?.map((t) => t.id).sort()).toEqual(['d1', 'r1', 'w1'])
  })

  it('allows merge when resume attach continues same run', () => {
    expect(
      assistantRowAcceptsStreamContinuation(
        {
          role: 'assistant',
          text: 'partial from db',
          durationStr: '1.2s',
          tokenStr: '88',
          runId: 'run-a',
        },
        'run-a',
        { resumeAttachSameRun: true },
      ),
    ).toBe(true)
    expect(
      assistantRowAcceptsStreamContinuation(
        {
          role: 'assistant',
          text: 'done',
          durationStr: '1.2s',
          runId: 'run-a',
        },
        'run-a',
      ),
    ).toBe(false)
  })

  it('allows merge for same-run live stream checkpoint with duration/token', () => {
    expect(
      assistantRowAcceptsStreamContinuation(
        {
          role: 'assistant',
          text: 'round one',
          durationStr: '2.1s',
          tokenStr: '120',
          runId: 'run-a',
        },
        'run-a',
        { liveStreamSameRun: true },
      ),
    ).toBe(true)
    expect(
      assistantRowAcceptsStreamContinuation(
        {
          role: 'assistant',
          text: 'done',
          durationStr: '2.1s',
          runId: 'run-a',
        },
        'run-b',
        { liveStreamSameRun: true },
      ),
    ).toBe(false)
  })

  it('does not merge completed assistant after final when live run id cleared', () => {
    expect(
      assistantRowAcceptsStreamContinuation(
        {
          role: 'assistant',
          text: 'done',
          durationStr: '2.1s',
          tokenStr: '120',
          runId: 'run-a',
        },
        '',
        { liveStreamSameRun: true },
      ),
    ).toBe(false)
  })

  it('allows merge for client UUID vs wire run dual id during live stream', () => {
    expect(
      assistantRowAcceptsStreamContinuation(
        {
          role: 'assistant',
          text: 'partial',
          durationStr: '1.0s',
          runId: 'cb452e7f-f2f8-4753-91ce-2954a63b785b',
        },
        'run-deadbeef',
        { liveStreamSameRun: true },
      ),
    ).toBe(true)
  })

  it('prefers stream openText only — does not fall back to DB concat when segments own body', () => {
    const merged = mergeAssistantRowWithStreamRow(
      {
        role: 'assistant',
        text: '开场\n\n第一轮\n\n第二轮',
        segments: [
          { kind: 'text', text: '开场' },
          { kind: 'tools', ids: ['t1'] },
          { kind: 'text', text: '第一轮' },
        ],
        incompleteStream: true,
        timestamp: 1,
      },
      {
        role: '_stream',
        text: '',
        segments: [
          { kind: 'text', text: '开场' },
          { kind: 'tools', ids: ['t1'] },
          { kind: 'text', text: '第一轮' },
          { kind: 'tools', ids: ['t2'] },
        ],
        aguiTurn: { runId: 'run-a', finished: false },
        timestamp: 2,
      },
    )
    expect(merged.text).toBe('')
    expect(merged.segments).toHaveLength(4)
  })

  it('prefers stream superset body on resume merge without duplicating segments', () => {
    const merged = mergeAssistantRowWithStreamRow(
      {
        role: 'assistant',
        text: 'round one',
        segments: [{ kind: 'text', text: 'round one', segIndex: 0 }],
        tools: [{ id: 't1', name: 'search' }],
        durationStr: '2.1s',
        tokenStr: '120',
        timestamp: 1,
      },
      {
        role: '_stream',
        text: 'round one\n\nround two',
        segments: [
          { kind: 'text', text: 'round one', segIndex: 0 },
          { kind: 'tools', ids: ['t1'] },
          { kind: 'text', text: 'round two', segIndex: 1 },
        ],
        tools: [{ id: 't1', name: 'search' }, { id: 't2', name: 'read' }],
        timestamp: 2,
      },
    )
    expect(merged.text).toBe('round one\n\nround two')
    expect(merged.segments).toHaveLength(3)
    expect(merged.tools).toHaveLength(2)
    expect(merged.durationStr).toBe('2.1s')
    expect(merged.tokenStr).toBe('120')
  })

  it('does not duplicate agui goal segments when stream timeline already includes assistant prefix', () => {
    const shared = [
      { kind: 'reasoning', text: 'plan', id: 'r1' },
      { kind: 'tools', ids: ['t1'] },
      { kind: 'text', text: '工具间旁白' },
    ]
    const streamSegments = [...shared, { kind: 'tools', ids: ['t2'] }]
    const merged = mergeAssistantRowWithStreamRow(
      {
        role: 'assistant',
        text: '',
        segments: shared,
        tools: [{ id: 't1', name: 'scenario', status: 'ok' }],
        incompleteStream: true,
        runId: 'run-a',
        timestamp: 1,
      },
      {
        role: '_stream',
        text: '最终回复',
        segments: streamSegments,
        streamTailDedupeSegments: shared,
        tools: [
          { id: 't1', name: 'scenario', status: 'ok' },
          { id: 't2', name: 'find', status: 'running' },
        ],
        aguiTurn: { runId: 'run-a', threadId: 't1', finished: false },
        runId: 'run-a',
        timestamp: 2,
      },
    )
    expect(merged.segments).toHaveLength(4)
    expect(merged.segments).toEqual(streamSegments)
    expect(merged.streamTailDedupeSegments).toEqual(shared)
    expect(merged.aguiTurn).toEqual({ runId: 'run-a', threadId: 't1', finished: false })
  })

  it('falls back to merged segments for tail dedupe when stream row has no dedupe anchor', () => {
    const assistantSegments = [
      { kind: 'text', text: 'round one' },
      { kind: 'tools', ids: ['t1'] },
    ]
    const streamSegments = [{ kind: 'text', text: 'round two' }]
    const merged = mergeAssistantRowWithStreamRow(
      {
        role: 'assistant',
        text: '',
        segments: assistantSegments,
        incompleteStream: true,
        runId: 'run-a',
      },
      {
        role: '_stream',
        text: 'round two streaming',
        segments: streamSegments,
        runId: 'run-a',
      },
    )
    expect(merged.segments).toHaveLength(3)
    expect(merged.streamTailDedupeSegments).toHaveLength(3)
  })

  it('mergeStreamSnapIntoAssistantRow keeps authoritative seq timeline', () => {
    const assistant = {
      role: 'assistant',
      text: '',
      segments: [
        { kind: 'text', text: 'plan', seq: 1 },
        { kind: 'tools', ids: ['t1'], seq: 2 },
        { kind: 'text', text: 'body', seq: 3 },
      ],
      timestamp: 1,
    }
    const streamSnap = {
      role: '_stream',
      text: 'corrupt',
      segments: [
        { kind: 'tools', ids: ['t1', 't2', 't3'] },
        { kind: 'text', text: 'wrong order' },
      ],
      timestamp: 2,
    }
    const merged = mergeStreamSnapIntoAssistantRow(assistant, streamSnap)
    expect(merged.segments).toHaveLength(3)
    expect(merged.segments?.map((s) => s.kind)).toEqual(['text', 'tools', 'text'])
  })
})
