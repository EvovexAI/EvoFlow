/**
 * 员工面板发送目标选择：键不一致时**禁止**把消息塞进面板当前会话。
 *
 * 【self-evolution-bot · 2026-11-22 · 第126轮 · 模型:deepseek-v4.1-flash】
 * 现网实证（2026-11-22 19:46:57，agent=case-fullstack-dev）：
 *   后端 `chat_send` 已按 busy 判据 mint 了新会话
 *   `proactive:case-fullstack-dev:chat:2026-11-22T19-46-57…`，回执也带
 *   `busy_avoided_session_key` / `busy_avoided_reason=target_session_running_new_conversation_minted`；
 *   但 CDP 到面板后 exact 未命中 → `code-fallback` 命中旧面板的 sender，
 *   直接在**正在跑**的旧会话 `chat:dept-28baad343765` 里发了一条（回执 sessionKeyMatched=false）。
 *   于是「派单开独立新对话」在面板路径上完全失效，话照样插进别人的回合。
 * 本测试锁判据；反向验证：把 `requested === actual` 判据改恒真 → 本文件必须红。
 */

import { describe, expect, it } from 'vitest'

import {
  decidePaneSendTarget,
  findEmployeePaneSenderEntry,
  registerEmployeePaneSender,
  clearEmployeePaneSenders,
} from '../src/lib/right-stage/employee-pane-send-bridge.js'

const OLD_SK = 'proactive:case-fullstack-dev:chat:dept-28baad343765'
const NEW_SK = 'proactive:case-fullstack-dev:chat:2026-11-22T19-46-57.356323+08-00'

describe('decidePaneSendTarget', () => {
  it('请求键与面板键一致 → 直接用 sender（真流式）', () => {
    const t = decidePaneSendTarget({
      requestedSessionKey: OLD_SK,
      actualSessionKey: OLD_SK,
      matched: 'exact',
    })
    expect(t.useSender).toBe(true)
    expect(t.mode).toBe('pane-live')
    expect(t.pendingSessionKey).toBe(OLD_SK)
  })

  it('【核心】请求新会话、面板挂旧会话 → 禁止 code-fallback 发送，改 pending-open-switch', () => {
    const t = decidePaneSendTarget({
      requestedSessionKey: NEW_SK,
      actualSessionKey: OLD_SK,
      matched: 'code-fallback',
    })
    expect(t.useSender).toBe(false)
    expect(t.mode).toBe('pending-open-switch')
    // 必须排到**请求的那个新会话**，不是面板旧会话
    expect(t.pendingSessionKey).toBe(NEW_SK)
  })

  it('即便 matched=exact 但键不同也不许发（宁可不发也不张冠李戴）', () => {
    const t = decidePaneSendTarget({
      requestedSessionKey: NEW_SK,
      actualSessionKey: OLD_SK,
      matched: 'exact',
    })
    expect(t.useSender).toBe(false)
    expect(t.mode).toBe('pending-open-switch')
  })

  it('请求键为空（面板刚开、键未回填）→ 允许按 code 兜底', () => {
    const t = decidePaneSendTarget({
      requestedSessionKey: '',
      actualSessionKey: OLD_SK,
      matched: 'code-fallback',
    })
    expect(t.useSender).toBe(true)
    expect(t.pendingSessionKey).toBe(OLD_SK)
  })

  it('完全没有面板 sender → 必须走 pending-open，不许静默吞', () => {
    const t = decidePaneSendTarget({
      requestedSessionKey: NEW_SK,
      actualSessionKey: '',
      matched: null,
    })
    expect(t.useSender).toBe(false)
    expect(t.mode).toBe('pending-open-switch')
    expect(t.pendingSessionKey).toBe(NEW_SK)
  })

  it('反证：一致且 exact 时不得被判成 switch（正常路径不许被误杀）', () => {
    const t = decidePaneSendTarget({
      requestedSessionKey: NEW_SK,
      actualSessionKey: NEW_SK,
      matched: 'code-fallback',
    })
    expect(t.mode).toBe('pane-live')
    expect(t.useSender).toBe(true)
  })
})

describe('findEmployeePaneSenderEntry 与决策联动', () => {
  it('真实注册表：新键传入、旧会话已注册 → 命中 code-fallback，决策必须拒绝发送', () => {
    clearEmployeePaneSenders()
    let sent = ''
    registerEmployeePaneSender({
      agentCode: 'case-fullstack-dev',
      sessionKey: OLD_SK,
      send: (text) => {
        sent = text
        return true
      },
    })
    const hit = findEmployeePaneSenderEntry('case-fullstack-dev', NEW_SK)
    expect(hit?.matched).toBe('code-fallback')
    const t = decidePaneSendTarget({
      requestedSessionKey: NEW_SK,
      actualSessionKey: String(hit?.sessionKey || ''),
      matched: hit?.matched ?? null,
    })
    expect(t.useSender).toBe(false)
    expect(sent).toBe('') // 没有真的发出去
    clearEmployeePaneSenders()
  })

  it('反证：键一致时必须真的能发出去', () => {
    clearEmployeePaneSenders()
    let sent = ''
    registerEmployeePaneSender({
      agentCode: 'case-fullstack-dev',
      sessionKey: OLD_SK,
      send: (text) => {
        sent = text
        return true
      },
    })
    const hit = findEmployeePaneSenderEntry('case-fullstack-dev', OLD_SK)
    expect(hit?.matched).toBe('exact')
    const t = decidePaneSendTarget({
      requestedSessionKey: OLD_SK,
      actualSessionKey: String(hit?.sessionKey || ''),
      matched: 'exact',
    })
    expect(t.useSender).toBe(true)
    expect(t.mode).toBe('pane-live')
    clearEmployeePaneSenders()
  })
})
