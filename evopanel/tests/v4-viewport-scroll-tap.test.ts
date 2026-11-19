import { describe, expect, it } from 'vitest'
import {
  classifyScrollTopVerdict,
  formatConversationRecordCounts,
  formatScrollTopVerdict,
} from '../src/react/v4/v4-viewport-scroll-tap.ts'

describe('formatConversationRecordCounts', () => {
  it('shows displayed vs total clearly', () => {
    expect(
      formatConversationRecordCounts({
        windowCount: 347,
        totalCount: 1342,
        windowTurnCount: 3,
        windowUserCount: 3,
      }),
    ).toBe('已显示 347 条 / 全量 1342 条（窗内 3 轮 · 用户气泡 3）')
  })

  it('handles missing total', () => {
    expect(
      formatConversationRecordCounts({
        windowCount: 12,
        totalCount: null,
      }),
    ).toBe('已显示 12 条 / 全量 ∅')
  })
})

describe('classifyScrollTopVerdict prefetch zone', () => {
  it('does not claim autoload when hasOlder=0', () => {
    const v = classifyScrollTopVerdict({
      scrollTop: 100,
      clientHeight: 600,
      scrollHeight: 2800,
      hasOlder: false,
      loadingOlder: false,
      firstRowId: null,
      windowFirstRowId: null,
    })
    expect(v).toBe('prefetch_zone_no_older')
    expect(formatScrollTopVerdict(v)).toContain('无更早可拉')
  })

  it('claims autoload only when hasOlder=1 in prefetch zone', () => {
    const v = classifyScrollTopVerdict({
      scrollTop: 100,
      clientHeight: 600,
      scrollHeight: 2800,
      hasOlder: true,
      loadingOlder: false,
      firstRowId: 1,
      windowFirstRowId: 200,
    })
    expect(v).toBe('prefetch_zone')
    expect(formatScrollTopVerdict(v)).toContain('可自动拉更早')
  })
})
