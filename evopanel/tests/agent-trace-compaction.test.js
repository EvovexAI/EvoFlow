import { describe, expect, it } from 'vitest'
import {
  formatModelInputTokensWithCompaction,
  compactionMetaFromUsage,
} from '../src/pages/agent-trace-compaction.js'

describe('agent-trace-compaction', () => {
  it('extracts compaction meta from usage_json', () => {
    const meta = compactionMetaFromUsage({
      prompt_tokens: 104512,
      compaction: {
        compaction_applied: true,
        compaction_before_gate_tokens: 118000,
        compaction_after_gate_tokens: 104000,
        compaction_saved_gate_tokens: 14000,
        compaction_saved_pct: 11.9,
      },
    })
    expect(meta?.compaction_saved_gate_tokens).toBe(14000)
  })

  it('renders input tokens with delta badge', () => {
    const { cellHtml, title } = formatModelInputTokensWithCompaction(
      {
        prompt_tokens: 104512,
        compaction: {
          compaction_applied: true,
          compaction_before_gate_tokens: 118000,
          compaction_after_gate_tokens: 104000,
          compaction_saved_gate_tokens: 14000,
          compaction_saved_pct: 11.9,
          compaction_passes: ['pass1'],
        },
      },
      '104512',
    )
    expect(cellHtml).toContain('104512')
    expect(cellHtml).toContain('↓14k')
    expect(title).toContain('118k')
  })
})
