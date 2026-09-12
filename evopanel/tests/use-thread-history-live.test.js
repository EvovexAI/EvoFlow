import { describe, expect, it } from 'vitest'
import {
  assistantRowLooksTerminal,
  markResumeAnchorAssistantIncomplete,
  mergeLiveSnapshotRow,
  preferDbTerminalAssistantRows,
  shouldFetchLiveRunSnapshot,
  shouldMarkResumeAnchorForRun,
} from '../src/react/hooks/useThreadHistory.ts'
import { mergeSoftHistoryFetch } from '../src/react/lib/merge-soft-history-fetch.ts'
import {
  historyLoadOlderScrollBufferPx,
  shouldPrefetchOlderHistory,
} from '../src/react/hooks/history-pagination.ts'

describe('mergeLiveSnapshotRow', () => {
  it('enriches existing assistant row by runId instead of appending duplicate', () => {
    const rows = [
      { role: 'user', text: 'hi' },
      {
        role: 'assistant',
        text: 'plan only',
        runId: 'run-1',
        content_json: { content: 'plan only' },
      },
    ]
    const merged = mergeLiveSnapshotRow(rows, {
      runId: 'run-1',
      status: 'aborted',
      partialText: 'plan only report',
      partialDisplaySegments: [
        { kind: 'text', text: 'plan only', seq: 1 },
        { kind: 'reasoning', text: 'think', seq: 2 },
        { kind: 'text', text: 'report', seq: 3 },
      ],
      lastEventAtMs: 999,
    })
    expect(merged).toHaveLength(2)
    expect(merged[1].segments?.map((s) => s.seq)).toEqual([1, 2, 3])
    expect(merged[1].incompleteStream).toBe(true)
    expect(merged[1].reasoningPreview).toBe('think')
  })

  it('clears duration metrics when enriching active snapshot row', () => {
    const rows = [
      { role: 'user', text: 'hi' },
      {
        role: 'assistant',
        text: 'plan only',
        runId: 'run-1',
      },
    ]
    const merged = mergeLiveSnapshotRow(rows, {
      runId: 'run-1',
      status: 'running',
      partialText: 'plan only report',
      partialTools: [{ id: 't2', name: 'read', status: 'running' }],
    })
    expect(merged[1].incompleteStream).toBe(true)
    expect(merged[1].durationStr).toBeUndefined()
    expect(merged[1].tokenStr).toBeUndefined()
  })

  it('ignores stale running snapshot when DB assistant is already terminal', () => {
    const rows = [
      { role: 'user', text: 'hi' },
      {
        role: 'assistant',
        text: 'final answer',
        runId: 'run-1',
        durationStr: '3.2s',
        tokenStr: '120 tok',
        tools: [{ id: 't1', name: 'read', status: 'ok' }],
      },
    ]
    const merged = mergeLiveSnapshotRow(rows, {
      runId: 'run-1',
      status: 'running',
      partialText: 'partial',
      partialTools: [{ id: 't2', name: 'write', status: 'running' }],
    })
    expect(merged).toEqual(rows)
  })
})

describe('shouldFetchLiveRunSnapshot', () => {
  it('does not fetch for idle session with stale currentRunId only', () => {
    expect(shouldFetchLiveRunSnapshot('idle')).toBe(false)
    expect(shouldFetchLiveRunSnapshot('completed')).toBe(false)
    expect(shouldFetchLiveRunSnapshot('running')).toBe(true)
  })
})

describe('preferDbTerminalAssistantRows', () => {
  it('restores DB terminal row when live-run merge left running tools', () => {
    const db = [
      { role: 'user', text: 'q' },
      {
        role: 'assistant',
        text: 'done',
        runId: 'r1',
        durationStr: '2s',
        tokenStr: '50 tok',
        tools: [{ id: 't1', name: 'read', status: 'ok' }],
      },
    ]
    const polluted = [
      { role: 'user', text: 'q' },
      {
        role: 'assistant',
        text: 'done',
        runId: 'r1',
        incompleteStream: true,
        tools: [
          { id: 't1', name: 'read', status: 'ok' },
          { id: 't2', name: 'write', status: 'running' },
        ],
      },
    ]
    const out = preferDbTerminalAssistantRows(polluted, db)
    expect(out[1].incompleteStream).toBeUndefined()
    expect(out[1].durationStr).toBe('2s')
    expect(out[1].tools).toEqual([{ id: 't1', name: 'read', status: 'ok' }])
  })
})

describe('assistantRowLooksTerminal', () => {
  it('detects terminal assistant from duration metrics', () => {
    expect(
      assistantRowLooksTerminal({
        role: 'assistant',
        text: 'x',
        durationStr: '1s',
      }),
    ).toBe(true)
    expect(
      assistantRowLooksTerminal({
        role: 'assistant',
        text: 'x',
        incompleteStream: true,
        durationStr: '1s',
      }),
    ).toBe(false)
  })
})

describe('shouldMarkResumeAnchorForRun', () => {
  it('marks active run statuses', () => {
    expect(shouldMarkResumeAnchorForRun('running')).toBe(true)
    expect(shouldMarkResumeAnchorForRun('pending')).toBe(true)
    expect(shouldMarkResumeAnchorForRun('aborted')).toBe(true)
    expect(shouldMarkResumeAnchorForRun('completed')).toBe(false)
  })
})

describe('markResumeAnchorAssistantIncomplete', () => {
  it('marks matching run assistant incomplete for stream resume merge', () => {
    const rows = [
      { role: 'user', text: 'go', runId: 'run-1' },
      {
        role: 'assistant',
        text: 'partial answer',
        runId: 'run-1',
        durationStr: '1.2s',
        tokenStr: '88',
      },
    ]
    const out = markResumeAnchorAssistantIncomplete(rows, 'run-1')
    expect(out[1].incompleteStream).toBe(true)
    expect(out[1].durationStr).toBeUndefined()
    expect(out[1].tokenStr).toBeUndefined()
  })

  it('falls back to last assistant in current turn when runId not on row', () => {
    const rows = [
      { role: 'user', text: 'go' },
      { role: 'assistant', text: 'partial answer', durationStr: '2s' },
    ]
    const out = markResumeAnchorAssistantIncomplete(rows, '019ef255-6e87-7762-af0d-f8965a1a99d5')
    expect(out[1].incompleteStream).toBe(true)
    expect(out[1].runId).toBe('019ef255-6e87-7762-af0d-f8965a1a99d5')
    expect(out[1].durationStr).toBeUndefined()
  })
})

describe('mergeSoftHistoryFetch', () => {
  it('keeps longer idle cache when network page shares the same tail', () => {
    const current = [
      { role: 'user', text: 'old', messageId: 'm1' },
      { role: 'assistant', text: 'old-a', messageId: 'm2' },
      { role: 'user', text: 'new', messageId: 'm3' },
      { role: 'assistant', text: 'new-a', messageId: 'm4' },
    ]
    const fetched = [
      { role: 'user', text: 'new', messageId: 'm3' },
      { role: 'assistant', text: 'new-a', messageId: 'm4' },
    ]
    expect(mergeSoftHistoryFetch(current, fetched)).toEqual(current)
  })

  it('stitches newer tail onto longer cache when overlap exists', () => {
    const current = [
      { role: 'user', text: 'old', messageId: 'm1' },
      { role: 'assistant', text: 'old-a', messageId: 'm2' },
      { role: 'user', text: 'mid', messageId: 'm3' },
    ]
    const fetched = [
      { role: 'user', text: 'mid', messageId: 'm3' },
      { role: 'assistant', text: 'mid-a', messageId: 'm4' },
    ]
    expect(mergeSoftHistoryFetch(current, fetched).map((r) => r.messageId)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
    ])
  })
})

describe('history pagination scroll buffer', () => {
  it('uses ~1 viewport height clamped between min and max', () => {
    expect(historyLoadOlderScrollBufferPx(400)).toBe(400)
    expect(historyLoadOlderScrollBufferPx(100)).toBe(320)
    expect(historyLoadOlderScrollBufferPx(800)).toBe(720)
  })

  it('prefetches before scroll reaches the top', () => {
    expect(shouldPrefetchOlderHistory({ scrollTop: 200, clientHeight: 400 })).toBe(true)
    expect(shouldPrefetchOlderHistory({ scrollTop: 500, clientHeight: 400 })).toBe(false)
  })
})
