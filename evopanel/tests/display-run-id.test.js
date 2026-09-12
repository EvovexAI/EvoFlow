import { describe, it, expect } from 'vitest'
import { enrichDisplayRowsRunIds, messagesToDisplayRows } from '../src/lib/chat-normalize.js'
import { historyItemStableKey } from '../src/react/lib/history-row-stable-key.ts'

describe('historyItemStableKey', () => {
  it('keeps optimistic user row key when runId is added on run_started', () => {
    const sk = 'sess-1'
    const ts = 1_700_000_000_000
    const before = { role: 'user', text: 'hello', timestamp: ts }
    const after = { role: 'user', text: 'hello', timestamp: ts, runId: 'run-abc' }
    expect(historyItemStableKey(sk, before, 3)).toBe(historyItemStableKey(sk, after, 3))
  })

  it('prefers messageId when present', () => {
    const row = { role: 'user', text: 'hi', messageId: 'msg-1', runId: 'run-1', timestamp: 1 }
    expect(historyItemStableKey('s', row, 0)).toBe('s|mid|msg-1')
  })
})

describe('enrichDisplayRowsRunIds', () => {
  it('stamps assistant row and nested tools with turn runId', () => {
    const rows = enrichDisplayRowsRunIds([
      { role: 'user', text: 'hi', runId: 'run-1' },
      {
        role: 'assistant',
        text: 'ok',
        tools: [
          { name: 'scenario', status: 'ok' },
          { name: 'web_search', status: 'ok' },
        ],
      },
    ])
    expect(rows[1].runId).toBe('run-1')
    expect(rows[1].tools[0].runId).toBe('run-1')
    expect(rows[1].tools[1].runId).toBe('run-1')
  })
})

describe('messagesToDisplayRows runId', () => {
  it('propagates run_id from user through tool ToolMessage merge', () => {
    const rows = messagesToDisplayRows([
      { role: 'user', type: 'human', content: 'q', run_id: 'run-x' },
      {
        role: 'assistant',
        type: 'AIMessage',
        content: '',
        tool_calls: [{ id: 'tc1', name: 'list_dir', args: {} }],
        run_id: 'run-x',
      },
      {
        role: 'tool',
        type: 'ToolMessage',
        name: 'list_dir',
        content: '[]',
        tool_call_id: 'tc1',
      },
    ])
    const assistant = rows.find((r) => r.role === 'assistant')
    expect(assistant?.runId).toBe('run-x')
    expect(assistant?.tools?.[0]?.runId).toBe('run-x')
  })
})
