import { describe, expect, it } from 'vitest'
import {
  ensureSubtaskRowSegments,
  expandRowsToTrailTurns,
  messagesToSubtaskModalRows,
  rowHasStructuredTimeline,
} from '../src/lib/subtask-modal-rows.js'

describe('rowHasStructuredTimeline', () => {
  it('detects reasoning segments without tools', () => {
    expect(
      rowHasStructuredTimeline({
        role: 'assistant',
        segments: [{ kind: 'reasoning', text: 'planning' }, { kind: 'text', text: 'hello' }],
      }),
    ).toBe(true)
  })

  it('detects reasoningPreview without segments', () => {
    expect(
      rowHasStructuredTimeline({
        role: 'assistant',
        text: 'reply',
        reasoningPreview: 'thinking…',
      }),
    ).toBe(true)
  })
})

describe('ensureSubtaskRowSegments', () => {
  it('builds tools segment when row has tools but no segments', () => {
    const row = ensureSubtaskRowSegments({
      role: 'assistant',
      text: 'planning',
      tools: [{ id: 'tc1', name: 'read_file', status: 'ok' }],
    })
    expect(row.segments).toEqual([
      { kind: 'text', text: 'planning' },
      { kind: 'tools', ids: ['tc1'] },
    ])
  })

  it('builds reasoning segment from reasoningPreview', () => {
    const row = ensureSubtaskRowSegments({
      role: 'assistant',
      text: 'done',
      reasoningPreview: 'Let me check',
    })
    expect(row.segments).toEqual([
      { kind: 'reasoning', text: 'Let me check' },
      { kind: 'text', text: 'done' },
    ])
  })
})

describe('messagesToSubtaskModalRows', () => {
  it('preserves tool structure from LangGraph-like messages', () => {
    const rows = messagesToSubtaskModalRows([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me read the file.' },
          { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } },
        ],
        tool_calls: [{ id: 'call_1', name: 'read_file' }],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'file contents',
      },
      {
        role: 'assistant',
        content: 'Done reading.',
      },
    ])
    expect(rows.length).toBeGreaterThan(0)
    const withTools = rows.find((r) => Array.isArray(r.tools) && r.tools.length > 0)
    expect(withTools).toBeTruthy()
    expect(withTools?.segments?.some((s) => s.kind === 'tools')).toBe(true)
  })
})

describe('expandRowsToTrailTurns', () => {
  it('splits one assistant bubble into per-tool left-clock turns', () => {
    const turns = expandRowsToTrailTurns([
      {
        role: 'user',
        text: 'duty brief',
        timestamp: 1_720_000_000_000,
      },
      {
        role: 'assistant',
        text: 'working',
        timestamp: 1_720_000_001_000,
        tools: [
          { id: 't1', name: 'read', time: 1_720_000_002_100, status: 'ok' },
          { id: 't2', name: 'terminal', time: 1_720_000_002_500, status: 'ok' },
        ],
        segments: [
          { kind: 'text', text: 'working' },
          { kind: 'tools', ids: ['t1', 't2'] },
        ],
      },
    ])
    expect(turns.map((t) => t.timestamp)).toEqual([
      1_720_000_000_000,
      1_720_000_001_000,
      1_720_000_002_100,
      1_720_000_002_500,
    ])
    expect(turns.filter((t) => (t.row.tools || []).length === 1)).toHaveLength(2)
  })

  it('does not put the same body in both text and segments', () => {
    const turns = expandRowsToTrailTurns([
      {
        role: 'assistant',
        text: '口播稿已写好。现在更新进度并交工提审',
        timestamp: 100,
        segments: [{ kind: 'text', text: '口播稿已写好。现在更新进度并交工提审' }],
      },
    ])
    expect(turns).toHaveLength(1)
    expect(String(turns[0].row.text || '')).toBe('')
    expect(turns[0].row.segments).toEqual([
      { kind: 'text', text: '口播稿已写好。现在更新进度并交工提审' },
    ])
  })

  it('keeps duty wrap-up body when segments only have tools', () => {
    const body = '本轮值班开始。\n\n结论：看板上无其他卡住事项，本轮值班结束。'
    const row = ensureSubtaskRowSegments({
      role: 'assistant',
      text: body,
      tools: [{ id: 'call_1', name: 'platform', status: 'ok' }],
      segments: [{ kind: 'tools', ids: ['call_1'] }],
    })
    expect(row.segments?.some((s) => s.kind === 'text' && String(s.text).includes('本轮值班结束'))).toBe(
      true,
    )
    const turns = expandRowsToTrailTurns([row])
    const textTurns = turns.filter((t) =>
      (t.row.segments || []).some((s) => s.kind === 'text' && String(s.text).includes('本轮值班结束')),
    )
    expect(textTurns.length).toBeGreaterThanOrEqual(1)
  })
})
