import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyStageSetPayload } from '../src/lib/right-stage/right-stage-agui.js'
import { setCurrentRightStageSessionKey } from '../src/lib/right-stage/right-stage-scope.js'
import {
  clearRightStageSessionMemory,
  switchRightStageSession,
} from '../src/lib/right-stage/right-stage-session-memory.js'
import { rightStageStore } from '../src/lib/right-stage/right-stage-store.js'

/**
 * 回归：别的会话即便带 expand=true，也不得写进当前 UI 右栏（侧边串台）。
 * expand 只表示「所属会话里要撑开」——切回该会话才看见。
 */
describe('applyStageSetPayload · expand 不得跨会话串台', () => {
  const uiSk = 'agent:main:new-a8d17462'
  const ownerSk = 'proactive:self-evolution-bot:chat:2026-11-19T16-15-39.290Z'

  beforeEach(() => {
    clearRightStageSessionMemory()
    setCurrentRightStageSessionKey(uiSk)
    rightStageStore.hideAll()
    rightStageStore.applyRemote({ action: 'hide', surface: null })
  })

  afterEach(() => {
    rightStageStore.hideAll()
    clearRightStageSessionMemory()
    setCurrentRightStageSessionKey('')
  })

  it('expand=true 但归属是后台会话：只写冻结记忆，不污染当前右栏', () => {
    applyStageSetPayload(
      {
        action: 'show',
        surface: { kind: 'shell-page', id: 'shell:/tasks', data: { path: '/tasks' } },
      },
      { sessionKey: uiSk },
    )

    const ok = applyStageSetPayload(
      {
        action: 'show',
        surface: {
          kind: 'web-embed',
          id: 'primary',
          title: '后台展开页',
          data: { url: 'https://example.com' },
          expand: true,
        },
      },
      { sessionKey: ownerSk },
    )
    expect(ok).toBe(true)

    const snap = rightStageStore.getSnapshot()
    expect((snap.tabs || []).map((t) => `${t.kind}:${t.id}`)).toEqual([
      'shell-page:shell:/tasks',
    ])
    expect(snap.activeKey).toBe('shell-page:shell:/tasks')

    // 切到归属会话：冻结记忆里的 web-embed 应换出并激活
    switchRightStageSession(uiSk, ownerSk)
    const ownerSnap = rightStageStore.getSnapshot()
    expect((ownerSnap.tabs || []).map((t) => `${t.kind}:${t.id}`)).toContain(
      'web-embed:primary',
    )
    expect(ownerSnap.activeKey).toBe('web-embed:primary')
    expect(ownerSnap.collapsed).toBe(false)
  })

  it('不带 expand 时仍按后台隔离：不抢当前右栏', () => {
    applyStageSetPayload(
      {
        action: 'show',
        surface: { kind: 'shell-page', id: 'shell:/tasks', data: { path: '/tasks' } },
      },
      { sessionKey: uiSk },
    )
    expect((rightStageStore.getSnapshot().tabs || []).length).toBe(1)

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
    expect((after.tabs || []).map((t) => `${t.kind}:${t.id}`)).toEqual([
      'shell-page:shell:/tasks',
    ])
    expect(after.activeKey).toBe('shell-page:shell:/tasks')
  })

  it('同会话 expand=true：写 live 并激活', () => {
    const ok = applyStageSetPayload(
      {
        action: 'show',
        surface: {
          kind: 'web-embed',
          id: 'primary',
          title: '本会话展开',
          data: { url: 'https://example.com' },
          expand: true,
        },
      },
      { sessionKey: uiSk },
    )
    expect(ok).toBe(true)
    const snap = rightStageStore.getSnapshot()
    expect((snap.tabs || []).map((t) => `${t.kind}:${t.id}`)).toContain('web-embed:primary')
    const tab = (snap.tabs || []).find((t) => `${t.kind}:${t.id}` === 'web-embed:primary')
    expect(tab?.sessionKey).toBe(uiSk)
    expect(snap.activeKey).toBe('web-embed:primary')
    expect(snap.collapsed).toBe(false)
  })
})
