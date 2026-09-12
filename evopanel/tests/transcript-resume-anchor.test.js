import { describe, expect, it } from 'vitest'
import {
  applyTranscriptResumeAnchorToLane,
  buildTranscriptResumeAnchorFromDisplayRows,
  buildTranscriptResumeAnchorFromRawMessages,
  laneShouldSkipPersistedTool,
} from '../src/lib/transcript-resume-anchor.js'

describe('transcript-resume-anchor', () => {
  it('builds anchor from raw messages for current turn', () => {
    const messages = [
      { role: 'user', run_id: 'r1', content_json: { content: 'hello' } },
      { role: 'assistant', run_id: 'r1', content_json: { content: 'step1' }, tool_calls: [{ id: 'tc1' }] },
      { role: 'tool', run_id: 'r1', tool_call_id: 'tc1' },
      { role: 'assistant', run_id: 'r1', content_json: { content: 'step2 partial' } },
    ]
    const anchor = buildTranscriptResumeAnchorFromRawMessages(messages, { runId: 'r1' })
    expect(anchor.persistedTurnText).toContain('step1')
    expect(anchor.persistedTurnText).toContain('step2 partial')
    expect(anchor.persistedToolCallIds).toEqual(['tc1'])
  })

  it('filters by runId', () => {
    const messages = [
      { role: 'user', run_id: 'r2', content_json: { content: 'q' } },
      { role: 'assistant', run_id: 'r1', content_json: { content: 'old run' } },
      { role: 'assistant', run_id: 'r2', content_json: { content: 'new run' } },
    ]
    const anchor = buildTranscriptResumeAnchorFromRawMessages(messages, { runId: 'r2' })
    expect(anchor.persistedTurnText).toBe('new run')
  })

  it('builds anchor from display rows', () => {
    const rows = [
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'A', tools: [{ id: 't1', name: 'read_file' }], runId: 'r1' },
      { role: 'assistant', text: 'B', runId: 'r1' },
    ]
    const anchor = buildTranscriptResumeAnchorFromDisplayRows(rows, { runId: 'r1' })
    expect(anchor.persistedTurnText).toContain('A')
    expect(anchor.persistedTurnText).toContain('B')
    expect(anchor.persistedToolCallIds).toEqual(['t1'])
  })

  it('applyTranscriptResumeAnchorToLane sets strip baseline without seeding finalText', () => {
    const lane = { finalText: '' }
    applyTranscriptResumeAnchorToLane(lane, {
      persistedTurnText: 'already in db',
      persistedToolCallIds: ['tc-old'],
    })
    expect(lane.finalText).toBe('')
    expect(lane.transcriptAnchorText).toBe('already in db')
    expect(lane.valuesBaselineLocked).toBe(true)
    expect(lane.valuesBaselineText).toBe('already in db')
    expect(laneShouldSkipPersistedTool(lane, 'tc-old')).toBe(true)
    expect(laneShouldSkipPersistedTool(lane, 'tc-new')).toBe(false)
  })
})
