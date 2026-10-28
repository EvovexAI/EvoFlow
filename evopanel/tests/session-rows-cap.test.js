/**
 * Regression: orchestration runs push one DisplayRow per turn, each carrying full-copy
 * terminalStreams (500KB/tool) + subagentTasks (64KB/subagent) + uncapped final text +
 * uncapped tool output — renderer OOM at ~1.7GB/min during long orchestration runs.
 * Session runtime rows must be count-capped and old rows must drop heavy live snapshots.
 */
import { describe, expect, it } from 'vitest'
import {
  PERSIST_TOOL_OUTPUT_CAP,
  SESSION_ROWS_HEAVY_HORIZON,
  SESSION_ROWS_MAX,
  capPersistedRowText,
  capPersistedToolOutput,
  capSessionRows,
} from '../src/react/lib/session-rows-cap.ts'
import {
  clearSessionRuntime,
  getSessionRuntime,
  updateSessionRuntimeRows,
} from '../src/react/lib/session-runtime-store.ts'
import { STREAM_ASSISTANT_BODY_CAP } from '../src/react/lib/stream-turn-engine.ts'

function heavyRow(i) {
  return {
    role: 'assistant',
    text: `row-${i}`,
    timestamp: i,
    terminalStreams: { t1: { name: 'bash', out: 'x'.repeat(1000) } },
    subagentTasks: { s1: { output: 'y'.repeat(1000) } },
    tools: [{ id: `tc-${i}`, name: 'bash', output: 'z'.repeat(2000), _terminalData: { out: 'w'.repeat(1000) } }],
  }
}

function lightRow(i) {
  return { role: 'user', text: `row-${i}`, timestamp: i }
}

describe('capSessionRows', () => {
  it('keeps only the newest SESSION_ROWS_MAX rows', () => {
    const rows = []
    const total = SESSION_ROWS_MAX + 50
    for (let i = 0; i < total; i++) rows.push(lightRow(i))
    const capped = capSessionRows(rows)
    expect(capped).toHaveLength(SESSION_ROWS_MAX)
    expect(capped[0].text).toBe(`row-${total - SESSION_ROWS_MAX}`)
    expect(capped[capped.length - 1].text).toBe(`row-${total - 1}`)
  })

  it('keeps arrays within cap untouched (same refs)', () => {
    const rows = [lightRow(0), lightRow(1)]
    expect(capSessionRows(rows)).toBe(rows)
  })

  it('strips terminalStreams/subagentTasks from rows older than the heavy horizon', () => {
    const old = []
    for (let i = 0; i < SESSION_ROWS_HEAVY_HORIZON + 10; i++) old.push(heavyRow(i))
    const capped = capSessionRows(old)
    const horizonStart = capped.length - SESSION_ROWS_HEAVY_HORIZON
    for (let i = 0; i < horizonStart; i++) {
      expect(capped[i].terminalStreams).toBeUndefined()
      expect(capped[i].subagentTasks).toBeUndefined()
    }
    for (let i = horizonStart; i < capped.length; i++) {
      expect(capped[i].terminalStreams).toBeDefined()
      expect(capped[i].subagentTasks).toBeDefined()
    }
  })

  it('caps tool output text and drops _terminalData on lightened rows, keeping the tail', () => {
    const rows = []
    for (let i = 0; i < SESSION_ROWS_HEAVY_HORIZON + 1; i++) rows.push(heavyRow(i))
    const capped = capSessionRows(rows)
    const oldTool = capped[0].tools[0]
    expect(oldTool.output.length).toBeLessThanOrEqual(PERSIST_TOOL_OUTPUT_CAP)
    expect(oldTool.output.endsWith('z'.repeat(64))).toBe(true)
    expect(oldTool._terminalData).toBeUndefined()
    const newTool = capped[capped.length - 1].tools[0]
    expect(newTool.output).toBe('z'.repeat(2000))
    expect(newTool._terminalData).toBeDefined()
  })

  it('leaves history-shaped rows (no heavy payloads) reference-intact', () => {
    const rows = []
    for (let i = 0; i < SESSION_ROWS_HEAVY_HORIZON + 5; i++) rows.push(lightRow(i))
    const capped = capSessionRows(rows)
    expect(capped[0]).toBe(rows[0])
  })
})

describe('capPersistedToolOutput', () => {
  it('keeps the tail of oversized output text', () => {
    const tool = { id: 'tc1', name: 'bash', output: 'a'.repeat(PERSIST_TOOL_OUTPUT_CAP + 1000) }
    const capped = capPersistedToolOutput(tool)
    expect(capped.output.length).toBeLessThanOrEqual(PERSIST_TOOL_OUTPUT_CAP)
    expect(capped.output.endsWith('a'.repeat(64))).toBe(true)
  })

  it('returns the same tool unchanged when output is within cap or absent', () => {
    const tool = { id: 'tc1', name: 'bash', output: 'short' }
    expect(capPersistedToolOutput(tool)).toBe(tool)
    const noOutput = { id: 'tc2', name: 'ls' }
    expect(capPersistedToolOutput(noOutput)).toBe(noOutput)
  })
})

describe('capPersistedRowText', () => {
  it('keeps the tail of oversized final assistant text at the stream body cap', () => {
    const text = 'b'.repeat(STREAM_ASSISTANT_BODY_CAP + 4096)
    const capped = capPersistedRowText(text)
    expect(capped.length).toBeLessThanOrEqual(STREAM_ASSISTANT_BODY_CAP)
    expect(capped.endsWith('b'.repeat(64))).toBe(true)
  })

  it('returns normal text unchanged', () => {
    expect(capPersistedRowText('hello')).toBe('hello')
  })
})

describe('updateSessionRuntimeRows applies the cap', () => {
  it('runtime rows never exceed SESSION_ROWS_MAX', () => {
    const sk = 'agent:main:rows-cap-integration'
    try {
      const rows = []
      for (let i = 0; i < SESSION_ROWS_MAX + 25; i++) rows.push(lightRow(i))
      updateSessionRuntimeRows(sk, (prev) => [...prev, ...rows])
      expect(getSessionRuntime(sk).rows.length).toBeLessThanOrEqual(SESSION_ROWS_MAX)
    } finally {
      clearSessionRuntime(sk)
    }
  })
})
