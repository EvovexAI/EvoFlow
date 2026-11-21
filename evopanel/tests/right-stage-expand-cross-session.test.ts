import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyStageSetPayload } from '../src/lib/right-stage/right-stage-agui.js'
import { setCurrentRightStageSessionKey } from '../src/lib/right-stage/right-stage-scope.js'
import { rightStageStore } from '../src/lib/right-stage/right-stage-store.js'

/**
 * 【self-evolution-bot · 2026-11-21 · 第106轮 · 模型:deepseek-v4.1-flash-1017】
 *
 * 回归：`expand=true` 的 show 在「事件归属 ≠ 用户当前 UI 会话」时必须落在**用户眼前**。
 *
 * 为什么（本轮现网日志定案的 44 秒真因，不是延迟）：
 *   13:26:37.506 我发 ui.show(web-embed, expand=true)；
 *   13:26:52 / 13:26:56 / 13:26:59 三条 web-state report 全是 12 个 screenshot 签在翻滚，
 *   **我的 web-embed 签一次都没上过报**；
 *   13:27:13.456 用户点发送切到我的会话 → 13:27:21.586 report 才变成 tabs=1 / web-embed。
 *   即：那签在 13:26:37 就被写进了「我的会话」的冻结记忆，用户切过来才被换出来。
 *   事件没丢也没有延迟 —— 是隔离分支吃掉了 expand。第104轮我只给进度类分支加了
 *   ``userInitiatedShow`` 豁免，web-embed / file 这类会话级 kind 走的是另一条分支，没有豁免。
 *
 * 判据（两条必须同时成立，缺一都会「分支放行了但屏幕上还是没有」）：
 *   ① 带 expand 时不进「只写冻结记忆」分支；
 *   ② 签的归属盖成当前 UI 会话，否则会被 ChatApp 按会话过滤掉。
 */
describe('applyStageSetPayload · expand 跨会话必须可见', () => {
  const uiSk = 'agent:main:new-a8d17462'
  const ownerSk = 'proactive:self-evolution-bot:chat:2026-11-19T16-15-39.290Z'

  beforeEach(() => {
    setCurrentRightStageSessionKey(uiSk)
    rightStageStore.hideAll()
    // hideAll 会把签清掉，但 activeKey/collapsed 也要归零，避免上一条用例残留。
    rightStageStore.applyRemote({ action: 'hide', surface: null })
  })

  afterEach(() => {
    rightStageStore.hideAll()
    setCurrentRightStageSessionKey('')
  })

  it('expand=true 时写进当前 UI 会话并激活（不被冻进归属会话）', () => {
    const ok = applyStageSetPayload(
      {
        action: 'show',
        surface: {
          kind: 'web-embed',
          id: 'primary',
          title: '第104轮验证A',
          data: { url: 'https://example.com' },
          expand: true,
        },
      },
      { sessionKey: ownerSk },
    )
    expect(ok).toBe(true)
    const snap = rightStageStore.getSnapshot()
    const keys = (snap.tabs || []).map((t) => `${t.kind}:${t.id}`)
    // ① 必须真的写进了 live 表（没被挪进冻结记忆）
    expect(keys).toContain('web-embed:primary')
    // ② 归属必须盖成用户此刻看的会话，否则会被会话过滤再次藏起来
    const tab = (snap.tabs || []).find((t) => `${t.kind}:${t.id}` === 'web-embed:primary')
    expect(tab?.sessionKey).toBe(uiSk)
    // ③ 必须是激活签：这次的目的就是让用户看见
    expect(snap.activeKey).toBe('web-embed:primary')
    expect(snap.collapsed).toBe(false)
  })

  it('不带 expand 时仍按后台隔离：不抢当前右栏', () => {
    // 先让用户右栏有一个自己的签，证明「没被顶掉」是有意义的断言
    applyStageSetPayload(
      { action: 'show', surface: { kind: 'shell-page', id: 'shell:/tasks', data: { path: '/tasks' } } },
      { sessionKey: uiSk },
    )
    const before = rightStageStore.getSnapshot()
    expect((before.tabs || []).length).toBe(1)

    applyStageSetPayload(
      {
        action: 'show',
        surface: {
          kind: 'web-embed',
          id: 'primary',
          data: { url: 'https://example.com' },
        },
      },
      { sessionKey: ownerSk },
    )

    const after = rightStageStore.getSnapshot()
    // 后台自动挂载不许出现在当前 UI 表里，也不许抢走 active
    expect((after.tabs || []).map((t) => `${t.kind}:${t.id}`)).toEqual(['shell-page:shell:/tasks'])
    expect(after.activeKey).toBe('shell-page:shell:/tasks')
  })
})
