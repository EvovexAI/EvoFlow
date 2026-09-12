import { describe, it, expect } from 'vitest'
import {
  mergeTurnRowsForPersist,
  sliceTurnMessagesForPersist,
} from '../src/lib/transcript-persist.js'

describe('mergeTurnRowsForPersist', () => {
  it('merges prefix-growing assistant snapshots into one row', () => {
    const merged = mergeTurnRowsForPersist([
      { role: 'assistant', messageId: 'a1', contentJson: { content: 'Hello' } },
      { role: 'assistant', messageId: 'a1', contentJson: { content: 'Hello world' } },
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].contentJson.content).toBe('Hello world')
  })

  it('merges delta reasoning pieces without losing spaces', () => {
    const merged = mergeTurnRowsForPersist([
      {
        role: 'assistant',
        messageId: 'a1',
        contentJson: { content: 'answer', reasoning: 'The' },
      },
      {
        role: 'assistant',
        messageId: 'a1',
        contentJson: { content: 'answer', reasoning: ' user' },
      },
      {
        role: 'assistant',
        messageId: 'a1',
        contentJson: { content: 'answer', reasoning: ' wants' },
      },
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].contentJson.reasoning).toBe('The user wants')
  })

  it('dedupes rows with the same messageId', () => {
    const merged = mergeTurnRowsForPersist([
      { role: 'assistant', messageId: 'x', contentJson: { content: 'same' } },
      { role: 'assistant', messageId: 'x', contentJson: { content: 'same' } },
    ])
    expect(merged).toHaveLength(1)
  })
})

describe('sliceTurnMessagesForPersist', () => {
  it('keeps tool between assistants separate', () => {
    const rows = sliceTurnMessagesForPersist([
      { type: 'human', content: 'q' },
      { type: 'ai', id: 'a1', content: 'step1' },
      { type: 'tool', id: 't1', tool_call_id: 'tc1', name: 'bash', content: 'ok' },
      { type: 'ai', id: 'a2', content: 'step2' },
    ])
    expect(rows.map((r) => r.role)).toEqual(['assistant', 'tool', 'assistant'])
  })
})
