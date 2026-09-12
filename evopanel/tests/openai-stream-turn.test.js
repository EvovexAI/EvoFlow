import { describe, expect, it } from 'vitest'
import {
  createOpenAiStreamLane,
  openAiChunkToStreamTurnEvents,
  openAiMetaToStreamTurnEvents,
} from '../src/react/lib/openai-stream-turn.ts'

describe('openAiChunkToStreamTurnEvents', () => {
  it('maps content delta to text_piece', () => {
    const lane = createOpenAiStreamLane()
    const events = openAiChunkToStreamTurnEvents(
      {
        object: 'chat.completion.chunk',
        choices: [{ delta: { content: 'hello' } }],
      },
      lane,
    )
    expect(events).toEqual([{ type: 'text_piece', piece: 'hello', phase: 'pre_tools' }])
  })

  it('maps reasoning_content to reasoning_piece', () => {
    const lane = createOpenAiStreamLane()
    const events = openAiChunkToStreamTurnEvents(
      {
        object: 'chat.completion.chunk',
        choices: [{ delta: { reasoning_content: 'think' } }],
      },
      lane,
    )
    expect(events).toEqual([{ type: 'reasoning_piece', piece: 'think' }])
  })

  it('fixes CJK spacing drift in reasoning_content', () => {
    const lane = createOpenAiStreamLane()
    const events = openAiChunkToStreamTurnEvents(
      {
        object: 'chat.completion.chunk',
        choices: [{ delta: { reasoning_content: '新 一轮' } }],
      },
      lane,
    )
    expect(events).toEqual([{ type: 'reasoning_piece', piece: '新一轮' }])
  })

  it('maps content delta to text_piece with content_phase', () => {
    const lane = createOpenAiStreamLane()
    const events = openAiChunkToStreamTurnEvents(
      {
        object: 'chat.completion.chunk',
        choices: [{ delta: { content: 'reply', content_phase: 'post_tools' } }],
      },
      lane,
    )
    expect(events).toEqual([{ type: 'text_piece', piece: 'reply', phase: 'post_tools' }])
    expect(lane.textPhase).toBe('post_tools')
  })

  it('accumulates tool_calls and emits tools then tools_update', () => {
    const lane = createOpenAiStreamLane()
    const e1 = openAiChunkToStreamTurnEvents(
      {
        object: 'chat.completion.chunk',
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  function: { name: 'read_file', arguments: '{' },
                },
              ],
            },
          },
        ],
      },
      lane,
    )
    expect(e1).toHaveLength(1)
    expect(e1[0].type).toBe('tools')
    expect(lane.textPhase).toBe('post_tools')

    const e2 = openAiChunkToStreamTurnEvents(
      {
        object: 'chat.completion.chunk',
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '"path":"a.ts"}' } }],
            },
          },
        ],
      },
      lane,
    )
    expect(e2).toHaveLength(1)
    expect(e2[0].type).toBe('tools_update')
  })
})

describe('openAiMetaToStreamTurnEvents', () => {
  it('maps tool_result to tools_update', () => {
    const events = openAiMetaToStreamTurnEvents({
      type: 'tool_result',
      tool_call_id: 'call_1',
      name: 'read_file',
      content: 'ok',
      status: 'ok',
    })
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('tools_update')
  })
})
