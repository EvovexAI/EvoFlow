import { describe, expect, it } from 'vitest'
import {
  collectVirtualizationProbe,
  formatVirtualizationProbeForDiag,
} from '../src/react/v4/v4-viewport-virtualization-probe.ts'
import type { ConversationRow } from '../src/zcode-shared/zcode-protocol-v4/index.ts'

function row(
  rowId: number,
  kind: ConversationRow['kind'],
  extra: Record<string, unknown> = {},
): ConversationRow {
  return { rowId, turnId: 't1', kind, ...extra } as ConversationRow
}

describe('collectVirtualizationProbe', () => {
  it('flags STREAM_AHEAD when stream tip exceeds winLast', () => {
    const windowRows = [
      row(2000, 'turnHeader', { state: 'running', turnId: 'live' }),
      row(2001, 'userInput', { origin: 'realUser', text: 'hi', turnId: 'live' }),
      row(2080, 'toolCall', { status: 'success', turnId: 'live' }),
    ]
    const probe = collectVirtualizationProbe({
      tid: 'sess',
      windowRows,
      windowCount: 3,
      totalCount: 2650,
      winFirst: 2366,
      winLast: 2080,
      hasOlder: true,
      loadingOlder: false,
      wouldTrigger: false,
      softCap: 220,
      nowMs: 10_000,
      streamEntries: [
        {
          atMs: 9_500,
          channel: 'v4',
          sessionId: 'sess',
          headline: '工具 · row#2154 · read',
        },
      ],
    })
    expect(probe.streamAhead).toBe(true)
    expect(probe.streamAheadDelta).toBe(74)
    expect(probe.flags.some((f) => f.startsWith('!STREAM_AHEAD'))).toBe(true)
    expect(probe.unsortedEnds).toBe(true)
  })

  it('format includes 虚拟化 section for copy-diag', () => {
    const probe = collectVirtualizationProbe({
      tid: 'sess',
      windowRows: [],
      windowCount: 0,
      totalCount: 0,
      winFirst: null,
      winLast: null,
      hasOlder: false,
      loadingOlder: false,
      wouldTrigger: false,
      softCap: 220,
    })
    const lines = formatVirtualizationProbeForDiag(probe)
    expect(lines[0]).toBe('### 虚拟化（投影窗）')
    expect(lines.some((l) => l.includes('softCap=220'))).toBe(true)
  })
})
