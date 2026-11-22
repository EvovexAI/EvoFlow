// 【self-evolution-bot · 2026-11-22 · 第118轮 · 模型:deepseek-v4.1-flash-1017】
// 守卫：chatSend 必须先「落 user 行」再 POST /runs/stream，否则 seq 会倒挂。
//
// 为什么用源码级的静态守卫（不是纯风格检查）：
//   这条约束的正确性只在两个独立事务的**先后顺序**上体现（前端 append 事务 vs 后端
//   assistant 落库事务），单测里没有第二个事务可供竞争，行为测试天然无力——mock 掉
//   fetch 之后无论 await 与否都绿，等于测不到东西。而一旦退回 fire-and-forget，
//   现网就会重新出现「答案渲染在提问之上」（本轮实测 13 对）。
//   所以这里锁的是**调用形状**，等价于把 2026-11-22 的现网证据钉成回归。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(__dirname, '..', 'src', 'lib', 'ws-client.js'), 'utf8')

describe('chatSend user-row ordering guard', () => {
  it('user 行落库是有界等待（await withTimeout），不是 fire-and-forget', () => {
    expect(SRC).toMatch(/await withTimeout\(\s*\n\s*appendSessionTranscriptMessage\(/)
  })

  it('不允许退回 `void appendSessionTranscriptMessage(`', () => {
    expect(SRC.includes('void appendSessionTranscriptMessage(')).toBe(false)
  })

  it('等待窗口有上限（2.5s），网关抖动时不能把发送卡死', () => {
    const m = SRC.match(
      /await withTimeout\(\s*\n\s*appendSessionTranscriptMessage\([\s\S]*?\n\s*(\d{3,5}),\s*\n\s*null,\s*\n\s*\)/,
    )
    expect(m).not.toBeNull()
    const ms = Number(m[1])
    expect(ms).toBeGreaterThanOrEqual(500)
    expect(ms).toBeLessThanOrEqual(5000)
  })

  it('落库失败仍继续发送（catch 在 withTimeout 之内）', () => {
    // 注意 CRLF：仓库行尾是 \r\n，字面 '...\n...' 锚点会 -1（本轮自撞一次）
    const m = /await withTimeout\(\r?\n\s*appendSessionTranscriptMessage\(/.exec(SRC)
    expect(m).not.toBeNull()
    const block = SRC.slice(m.index, m.index + 1400)
    expect(block).toContain('append user transcript deferred')
  })
})
