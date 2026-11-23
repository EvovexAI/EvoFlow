/**
 * 平台排队首条消息（pendingSendMessage）的准入判据。
 *
 * 【self-evolution-bot · 2026-11-22 · 第127轮 · 模型:deepseek-v4.1-flash】
 * 现网实证（2026-11-22 22:01:57，agent=case-fullstack-dev）：
 *   后端 busy 判据已 mint 新会话 `proactive:...:chat:2026-11-22T22-01-54.630947+08-00`，
 *   回执带 busy_avoided_session_key + panel_dispatch=pending-open-switch，右栏也开了签；
 *   但**全库 grep 探针 `POKE-BUSY-SECOND` 0 条**、新会话 `idle / message_count=0`。
 *   消息根本没发出：面板 `sending=true`（上一轮还在流式）时旧 effect `if (sending) return`
 *   既不排队也不留痕；且旧代码**先 clear 再 send**，出错即永久丢失。
 *
 * 本测试锁「忙必须 hold 不许丢」与「只有 send 才允许清签」两条结构判据。
 * 反向验证：把 `sessionBusy` 分支改成返回 skip → 第 1 组必须红。
 */

import { describe, expect, it, beforeEach } from 'vitest'

import {
  __resetPendingSendInflightForTests,
  clearPendingSendInflight,
  decidePendingSend,
  markPendingSendInflight,
  pendingSendDedupeKey,
} from '../src/lib/right-stage/pending-send-gate.js'

const CODE = 'case-fullstack-dev'
const NEW_SK = 'proactive:case-fullstack-dev:chat:2026-11-22T22-01-54.630947+08-00'
const POKE = 'POKE-BUSY-SECOND 只回一句话：收到了'

describe('pendingSendGate: 面板忙时不许把消息弄丢', () => {
  beforeEach(() => {
    __resetPendingSendInflightForTests()
  })

  it('面板正忙（sending=true）→ hold，不是 skip（skip 等于丢消息）', () => {
    const d = decidePendingSend({
      pendingText: POKE,
      agentCode: CODE,
      sessionKey: NEW_SK,
      sentKey: '',
      sessionBusy: true,
    })
    expect(d.action).toBe('hold')
    expect(d.reason).toBe('session-busy')
  })

  it('hold 不会写入「已发」判据键（下一轮 sending=false 还能再发）', () => {
    const held = decidePendingSend({
      pendingText: POKE,
      agentCode: CODE,
      sessionKey: NEW_SK,
      sessionBusy: true,
    })
    expect(held.action).toBe('hold')
    // 同一句在不忙时必须变成 send（若 hold 误记成已发，这里会是 already-sent）
    const next = decidePendingSend({
      pendingText: POKE,
      agentCode: CODE,
      sessionKey: NEW_SK,
      sessionBusy: false,
    })
    expect(next.action).toBe('send')
  })

  it('不忙 → send，并给出可幂等的 dedupe 键', () => {
    const d = decidePendingSend({
      pendingText: POKE,
      agentCode: CODE,
      sessionKey: NEW_SK,
      sessionBusy: false,
    })
    expect(d.action).toBe('send')
    expect(d.dedupeKey).toBe(
      pendingSendDedupeKey({ agentCode: CODE, sessionKey: NEW_SK, text: POKE }),
    )
  })
})

describe('pendingSendGate: 同一句不许发两遍', () => {
  beforeEach(() => {
    __resetPendingSendInflightForTests()
  })

  it('本实例已成功发过 → already-sent', () => {
    const key = pendingSendDedupeKey({ agentCode: CODE, sessionKey: NEW_SK, text: POKE })
    const d = decidePendingSend({
      pendingText: POKE,
      agentCode: CODE,
      sessionKey: NEW_SK,
      sentKey: key,
      sessionBusy: false,
    })
    expect(d.action).toBe('skip')
    expect(d.reason).toBe('already-sent')
  })

  it('另一实例正在发同一句 → in-flight（重挂载不重复发）', () => {
    const key = pendingSendDedupeKey({ agentCode: CODE, sessionKey: NEW_SK, text: POKE })
    expect(markPendingSendInflight(key)).toBe(true)
    const d = decidePendingSend({
      pendingText: POKE,
      agentCode: CODE,
      sessionKey: NEW_SK,
      sessionBusy: false,
    })
    expect(d.action).toBe('skip')
    expect(d.reason).toBe('in-flight')
    // 真发完（成败都算）后必须放行，否则失败重试会被自己挡死
    clearPendingSendInflight(key)
    const again = decidePendingSend({
      pendingText: POKE,
      agentCode: CODE,
      sessionKey: NEW_SK,
      sessionBusy: false,
    })
    expect(again.action).toBe('send')
  })

  it('同一 code 但会话键不同 → 不是同一句（换会话后仍要发）', () => {
    const oldKey = pendingSendDedupeKey({
      agentCode: CODE,
      sessionKey: 'proactive:case-fullstack-dev:chat:dept-28baad343765',
      text: POKE,
    })
    const d = decidePendingSend({
      pendingText: POKE,
      agentCode: CODE,
      sessionKey: NEW_SK,
      sentKey: oldKey,
      sessionBusy: false,
    })
    expect(d.action).toBe('send')
  })

  it('失败重试路径：清掉 in-flight 且没有 sentKey → 允许再发', () => {
    const key = pendingSendDedupeKey({ agentCode: CODE, sessionKey: NEW_SK, text: POKE })
    markPendingSendInflight(key)
    clearPendingSendInflight(key)
    const d = decidePendingSend({
      pendingText: POKE,
      agentCode: CODE,
      sessionKey: NEW_SK,
      sentKey: '',
      sessionBusy: false,
    })
    expect(d.action).toBe('send')
  })
})

describe('pendingSendGate: 不该动手的输入', () => {
  beforeEach(() => {
    __resetPendingSendInflightForTests()
  })

  it('空文本 → skip empty（不占坑、不清签）', () => {
    const d = decidePendingSend({ pendingText: '   ', agentCode: CODE, sessionBusy: false })
    expect(d.action).toBe('skip')
    expect(d.reason).toBe('empty')
  })

  it('没有 agentCode → skip（无归属就不知道该发给谁）', () => {
    const d = decidePendingSend({ pendingText: POKE, agentCode: '', sessionBusy: false })
    expect(d.action).toBe('skip')
    expect(d.reason).toBe('no-agent')
  })

  it('忙 + 空文本 → skip empty 优先于 hold（不制造无效等待）', () => {
    const d = decidePendingSend({ pendingText: '', agentCode: CODE, sessionBusy: true })
    expect(d.action).toBe('skip')
    expect(d.reason).toBe('empty')
  })

  it('占坑是幂等的：重复 mark 第二次返回 false', () => {
    const key = pendingSendDedupeKey({ agentCode: CODE, sessionKey: NEW_SK, text: POKE })
    expect(markPendingSendInflight(key)).toBe(true)
    expect(markPendingSendInflight(key)).toBe(false)
  })
})
