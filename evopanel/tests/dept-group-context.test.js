import { describe, it, expect } from 'vitest'
import {
  buildRecentGroupContext,
  estimateTokens,
} from '../src/react/lib/dept-group-context.js'

/**
 * 群近期上下文按 token 预算裁剪。
 *
 * 【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
 * 用户拍板「不按天翻篇」，所以这里只验一件事：上限由 token 决定，不由条数决定。
 */
describe('estimateTokens', () => {
  it('CJK 按字计，ASCII 按 4 字符 1 token', () => {
    expect(estimateTokens('你好世界')).toBe(4)
    expect(estimateTokens('abcdefgh')).toBe(2)
    expect(estimateTokens('')).toBe(0)
  })

  it('中英混排都算得上', () => {
    // 2 个 CJK + 9 个 ASCII（含空格）→ 2 + ceil(9/4) = 5
    expect(estimateTokens('你好 abcdefgh')).toBe(5)
  })
})

describe('buildRecentGroupContext（token 预算，不按条数）', () => {
  const mk = (i, text) => ({
    kind: 'agent',
    agentName: `岗位${i}`,
    agentCode: `bot-${i}`,
    text,
  })

  it('短消息能带远多于 8 条（证明没有写死条数上限）', () => {
    const msgs = Array.from({ length: 40 }, (_, i) => mk(i, '收到'))
    const out = buildRecentGroupContext(msgs, { budgetTokens: 2000 })
    // 每条「岗位N：收到」约 7 token，40 条约 280 token，远低于预算 → 必须全带
    expect(out.split('\n').length).toBe(40)
  })

  it('长消息按预算截断，总 token 不超过预算', () => {
    const long = '很长的回复内容'.repeat(60) // 每条约 420 字符
    const msgs = Array.from({ length: 30 }, (_, i) => mk(i, long))
    const out = buildRecentGroupContext(msgs, { budgetTokens: 500 })
    expect(estimateTokens(out)).toBeLessThanOrEqual(510) // 允许换行计数的极小误差
    expect(out.split('\n').length).toBeLessThan(30)
    expect(out.split('\n').length).toBeGreaterThan(0)
  })

  it('预算紧张时保留的是最新的那几条', () => {
    const msgs = [mk(1, '最早的话'), mk(2, '中间的话'), mk(3, '最新的话')]
    const out = buildRecentGroupContext(msgs, { budgetTokens: 12 })
    expect(out).toContain('最新的话')
    expect(out).not.toContain('最早的话')
  })

  it('跳过 system / streaming / 空正文', () => {
    const out = buildRecentGroupContext([
      { kind: 'system', text: '系统通知' },
      mk(1, '我会保留'),
      { kind: 'agent', agentName: 'X', streaming: true, text: '流式中' },
      { kind: 'agent', agentName: 'Y', text: '   ' },
    ])
    expect(out).toBe('岗位1：我会保留')
  })

  it('用户消息标成「用户」，成员用岗位名', () => {
    const out = buildRecentGroupContext([
      { kind: 'user', text: '大家好' },
      mk(1, '在的'),
    ])
    expect(out).toBe('用户：大家好\n岗位1：在的')
  })

  it('单条超长时按 perMsgCap 截断，不让它吃掉整个预算', () => {
    const out = buildRecentGroupContext([mk(1, 'A'.repeat(2000))], {
      budgetTokens: 2000,
      perMsgCap: 100,
    })
    expect(out.length).toBeLessThanOrEqual(120)
  })

  it('空列表返回空串，不抛错', () => {
    expect(buildRecentGroupContext([])).toBe('')
    expect(buildRecentGroupContext(null)).toBe('')
  })
})
