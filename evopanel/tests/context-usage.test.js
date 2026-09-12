import { describe, expect, it } from 'vitest'
import {
  buildContextUsageTitle,
  buildHeaderMetricsBubbleText,
  buildSessionTokenBubbleText,
  contextUsageLevel,
  contextUsageRatio,
  formatContextTokenCount,
  formatTokenCountDisplay,
  mergeContextUsageSnapshots,
  parseContextUsageFromSessionContext,
} from '../src/react/lib/context-usage.ts'

describe('context-usage helpers', () => {
  it('formats token counts', () => {
    expect(formatContextTokenCount(850)).toBe('850')
    expect(formatContextTokenCount(12500)).toBe('12.5k')
    expect(formatContextTokenCount(128000)).toBe('128k')
  })

  it('computes ratio capped at 1', () => {
    expect(contextUsageRatio(64000, 128000)).toBeCloseTo(0.5)
    expect(contextUsageRatio(200000, 128000)).toBe(1)
  })

  it('maps usage levels', () => {
    expect(contextUsageLevel(0.3)).toBe('low')
    expect(contextUsageLevel(0.6)).toBe('medium')
    expect(contextUsageLevel(0.8)).toBe('high')
    expect(contextUsageLevel(0.95)).toBe('critical')
  })

  it('formats large token counts', () => {
    expect(formatTokenCountDisplay(2596392)).toBe('2.60M')
    expect(formatTokenCountDisplay(19004)).toBe('19.0k')
    expect(formatTokenCountDisplay(2061120)).toBe('2.06M')
  })

  it('builds tooltip with compaction delta (no phase note)', () => {
    const title = buildContextUsageTitle({
      usedTokens: 18000,
      windowTokens: 128000,
      messageCount: 12,
      beforeTokens: 98000,
      compacted: true,
    })
    expect(title).toContain('18.0k / 128k tok ·')
    expect(title).toContain('12 条消息')
    expect(title).toContain('98.0k → 18.0k')
    expect(title).not.toContain('阶段')
    expect(title).not.toContain('after_model')
  })

  it('builds session token bubble with cache hit rate', () => {
    const text = buildSessionTokenBubbleText({
      input: 2596392,
      output: 19004,
      cacheRead: 2061120,
      cacheMiss: 248954,
    })
    expect(text).toContain('会话累计  输入 2.60M · 输出 19.0k')
    expect(text).toContain('命中率 89.2%')
    expect(text).toContain('命中 2.06M')
    expect(text).toContain('未命中 249k')
  })

  it('buildHeaderMetricsBubbleText joins context and session sections', () => {
    const text = buildHeaderMetricsBubbleText(
      { usedTokens: 27400, windowTokens: 524000, messageCount: 36, compacted: false },
      { input: 1000, output: 200, cacheRead: 800, cacheMiss: 200 },
    )
    expect(text).toContain('模型上下文')
    expect(text).toContain('会话累计')
    expect(text.split('\n\n').length).toBe(2)
  })

  it('buildHeaderMetricsBubbleText shows empty window hint when unused', () => {
    const text = buildHeaderMetricsBubbleText(
      { usedTokens: 0, windowTokens: 256000, compacted: false },
      null,
    )
    expect(text).toContain('256k')
    expect(text).toContain('发送消息后显示实际占用')
  })

  it('parses persisted session context_usage (snake_case)', () => {
    const snap = parseContextUsageFromSessionContext({
      context_usage: {
        used_tokens: 42000,
        window_tokens: 256000,
        message_count: 15,
        pct: 16.4,
        note: 'after_model',
        updated_at_ms: 1710000000000,
      },
    })
    expect(snap?.usedTokens).toBe(42000)
    expect(snap?.windowTokens).toBe(256000)
    expect(snap?.updatedAt).toBe(1710000000000)
  })

  it('mergeContextUsageSnapshots keeps newer updatedAt', () => {
    const older = {
      usedTokens: 1000,
      windowTokens: 128000,
      pct: 0.8,
      updatedAt: 100,
    }
    const newer = {
      usedTokens: 2000,
      windowTokens: 128000,
      pct: 1.6,
      updatedAt: 200,
    }
    expect(mergeContextUsageSnapshots(older, newer)).toEqual(newer)
    expect(mergeContextUsageSnapshots(newer, older)).toEqual(newer)
  })
})
