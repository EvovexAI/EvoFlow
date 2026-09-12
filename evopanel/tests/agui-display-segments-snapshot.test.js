import { describe, expect, it } from 'vitest'
import { agUiDisplaySegmentsFromMessagesSnapshot } from '../src/lib/ws-client.js'

describe('agUiDisplaySegmentsFromMessagesSnapshot', () => {
  it('maps reasoning and assistant text in order', () => {
    const segs = agUiDisplaySegmentsFromMessagesSnapshot([
      { id: 'r1', role: 'reasoning', content: 'think' },
      { id: 'b1', role: 'assistant', content: 'hello' },
    ])
    expect(segs).toEqual([
      { id: 'r1', seq: 1, kind: 'reasoning', text: 'think', block_kind: 'reasoning', blockKind: 'reasoning' },
      { id: 'b1', seq: 2, kind: 'text', text: 'hello', block_kind: 'plan_text', blockKind: 'plan_text' },
    ])
  })

  it('includes assistant toolCalls as interleaved tools segments', () => {
    const segs = agUiDisplaySegmentsFromMessagesSnapshot([
      { id: 'r1', role: 'reasoning', content: 'plan' },
      {
        id: 't-slot',
        role: 'assistant',
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'find', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
      { id: 'b1', role: 'assistant', content: 'done' },
    ])
    expect(segs.map((s) => s.kind)).toEqual(['reasoning', 'tools', 'text'])
    expect(segs[1]).toMatchObject({ kind: 'tools', ids: ['c1', 'c2'], seq: 2 })
    expect(segs[2]).toMatchObject({ kind: 'text', block_kind: 'body_text' })
  })

  it('skips role:tool rows so tool result JSON is not assistant text', () => {
    const toolResult = JSON.stringify({ status: 'ok', activated_now: ['read'] })
    const segs = agUiDisplaySegmentsFromMessagesSnapshot([
      { id: 'plan', role: 'assistant', content: '查找工具' },
      {
        id: 't-slot',
        role: 'assistant',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'tool_search', arguments: '{}' } }],
      },
      { id: 'c1-result', role: 'tool', toolCallId: 'c1', content: toolResult },
      { id: 'body', role: 'assistant', content: '已启用 read' },
    ])
    expect(segs.map((s) => s.kind)).toEqual(['text', 'tools', 'text'])
    const textBodies = segs.filter((s) => s.kind === 'text').map((s) => s.text)
    expect(textBodies).toEqual(['查找工具', '已启用 read'])
    expect(textBodies.join('')).not.toContain('activated_now')
  })

  it('keeps separate tools segments when snapshot has multiple toolCall messages', () => {
    const segs = agUiDisplaySegmentsFromMessagesSnapshot([
      { id: 't1', role: 'assistant', seq: 1, blockKind: 'tools', toolCalls: [{ id: 'c1' }] },
      { id: 'mid', role: 'assistant', seq: 2, blockKind: 'body_text', content: '中间' },
      { id: 't2', role: 'assistant', seq: 3, blockKind: 'tools', toolCalls: [{ id: 'c2' }] },
      { id: 'tail', role: 'assistant', seq: 4, blockKind: 'body_text', content: '结尾' },
    ])
    expect(segs.map((s) => s.kind)).toEqual(['tools', 'text', 'tools', 'text'])
    expect(segs.filter((s) => s.kind === 'tools')).toHaveLength(2)
  })
})
