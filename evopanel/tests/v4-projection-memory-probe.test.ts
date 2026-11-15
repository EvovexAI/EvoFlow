import { describe, expect, it } from 'vitest'
import {
  estimateConversationRowBytes,
} from '../src/zcode-ui/v4/conversationProjectionStore.ts'
import type { AssistantTextRow } from '../src/zcode-shared/zcode-protocol-v4/rows.ts'

const textRow: AssistantTextRow = {
  rowId: 1,
  turnId: 't1',
  kind: 'assistantText',
  text: 'x'.repeat(1000),
  state: 'complete',
  createdAt: 1,
  createdAtSeq: 1,
}

describe('estimateConversationRowBytes', () => {
  it('scales with row text size', () => {
    const bytes = estimateConversationRowBytes(textRow)
    // JSON 序列化长度 ≥ 正文长度（还有字段名/转义开销）
    expect(bytes).toBeGreaterThanOrEqual(1000)
    expect(bytes).toBeLessThan(2000)
  })

  it('returns 0 for unserializable rows instead of throwing', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(estimateConversationRowBytes(circular as never)).toBe(0)
  })
})
