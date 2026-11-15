import { describe, expect, it } from 'vitest'
import {
  formatAssistantUsageLabel,
  formatAssistantUsageTitle,
} from '../src/zcode-ui/v4/assistantUsageLabel.ts'
import type { AssistantUsage } from '../src/zcode-shared/zcode-protocol-v4/rows.ts'

const full: AssistantUsage = {
  inputTokens: 1200,
  outputTokens: 340,
  totalTokens: 1540,
  cacheReadTokens: 890,
  cacheWriteTokens: 12,
}

describe('formatAssistantUsageLabel', () => {
  it('formats ↑in ↓out with cache hit suffix', () => {
    expect(formatAssistantUsageLabel(full)).toBe('↑1200 ↓340 · ⚡890')
  })

  it('omits ⚡ segment when cacheRead is absent/zero', () => {
    expect(formatAssistantUsageLabel({ ...full, cacheReadTokens: undefined })).toBe(
      '↑1200 ↓340',
    )
    expect(formatAssistantUsageLabel({ ...full, cacheReadTokens: 0 })).toBe('↑1200 ↓340')
  })

  it('falls back to total-only string when in/out missing', () => {
    expect(formatAssistantUsageLabel({ inputTokens: 0, outputTokens: 0, totalTokens: 789 })).toBe(
      '789 tokens',
    )
  })

  it('returns null for empty usage', () => {
    expect(formatAssistantUsageLabel(null)).toBeNull()
    expect(formatAssistantUsageLabel(undefined)).toBeNull()
    expect(formatAssistantUsageLabel({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })).toBeNull()
  })
})

describe('formatAssistantUsageTitle', () => {
  it('joins cache hit / write / miss breakdown', () => {
    // 未命中 = 轮输入 1200 - 命中 890 - 写入 12 = 298
    expect(formatAssistantUsageTitle(full)).toBe('缓存命中 890 · 写入缓存 12 · 未命中 298')
  })

  it('returns null when no cache breakdown available', () => {
    expect(
      formatAssistantUsageTitle({ inputTokens: 1200, outputTokens: 340, totalTokens: 1540 }),
    ).toBeNull()
  })
})
