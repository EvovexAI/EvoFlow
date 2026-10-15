import { describe, expect, it } from 'vitest'
import {
  agUiDisplaySegmentsFromMessagesSnapshot,
  ensurePendingApprovalToolsSegments,
} from '../src/lib/ws-client.js'

function pendingApprovalEnvelope(toolCallId, toolName = 'terminal') {
  return JSON.stringify({
    _evoflow_tool: { status: 'pending_approval' },
    message: `[pending_approval] ${toolName}（…）尚未执行，等待用户授权。`,
    approval: { title: '需要您的授权', tool_name: toolName, tool_call_id: toolCallId, risk: 'confirm' },
  })
}

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

  it('emits a tools segment for a pending-approval tool row (approval hold)', () => {
    // 复现审批卡住:快照 assistant 消息不带 toolCalls,pending ToolMessage 是独立 role:tool 行。
    // 该行必须产出 tools 段,否则 final 落行后审批卡片从实时视图消失。
    const segs = agUiDisplaySegmentsFromMessagesSnapshot([
      { id: 'r1', role: 'reasoning', content: 'think' },
      { id: 'ai1', role: 'assistant', content: '' },
      { id: 'c9-result', role: 'tool', toolCallId: 'c9', content: pendingApprovalEnvelope('c9') },
    ])
    expect(segs.map((s) => s.kind)).toEqual(['reasoning', 'tools'])
    expect(segs[1]).toMatchObject({ kind: 'tools', ids: ['c9'] })
  })

  it('still skips non-pending role:tool rows (result JSON must not leak)', () => {
    const toolResult = JSON.stringify({ status: 'ok', output: '2026-10-15' })
    const segs = agUiDisplaySegmentsFromMessagesSnapshot([
      { id: 'ai1', role: 'assistant', content: '' },
      { id: 'c1-result', role: 'tool', toolCallId: 'c1', content: toolResult },
    ])
    expect(segs).toEqual([])
  })
})

describe('ensurePendingApprovalToolsSegments', () => {
  it('inserts pending tools segment into backend display_segments by seq', () => {
    const segs = ensurePendingApprovalToolsSegments(
      [
        { id: 'r1', seq: 1, kind: 'reasoning', text: 'think' },
        { id: 'b1', seq: 3, kind: 'text', text: 'body' },
      ],
      [{ id: 'c9-result', role: 'tool', toolCallId: 'c9', seq: 2, content: pendingApprovalEnvelope('c9') }],
    )
    expect(segs.map((s) => s.kind)).toEqual(['reasoning', 'tools', 'text'])
    expect(segs[1]).toMatchObject({ kind: 'tools', ids: ['c9'] })
  })

  it('does not duplicate when a tools segment already covers the id', () => {
    const segs = ensurePendingApprovalToolsSegments(
      [{ id: 't-slot', seq: 1, kind: 'tools', ids: ['c9'] }],
      [{ id: 'c9-result', role: 'tool', toolCallId: 'c9', content: pendingApprovalEnvelope('c9') }],
    )
    expect(segs).toHaveLength(1)
  })

  it('returns segments unchanged when snapshot is missing or has no pending rows', () => {
    const segs = [{ id: 'b1', seq: 1, kind: 'text', text: 'body' }]
    expect(ensurePendingApprovalToolsSegments(segs, null)).toBe(segs)
    expect(
      ensurePendingApprovalToolsSegments(
        segs,
        [{ id: 'c1-result', role: 'tool', toolCallId: 'c1', content: JSON.stringify({ status: 'ok' }) }],
      ),
    ).toBe(segs)
  })
})
