import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STAGE_SET_APPLIED_EVENT,
  applyStageSetPayload,
} from '../src/lib/right-stage/right-stage-agui.js'
import { setCurrentRightStageSessionKey } from '../src/lib/right-stage/right-stage-scope.js'
import { rightStageStore } from '../src/lib/right-stage/right-stage-store.js'

/**
 * 回归：artifacts 分支早退时丢了事件归属会话，
 * 导致 syncRemoteStageSet 拿不到 sessionKey（路径解析用错线程沙箱、
 * 小V语音全屏时文件签钉错会话 → 被过滤成「看不见」）。
 */
describe('applyStageSetPayload · artifacts 会话归属', () => {
  let events: Array<{ action?: string; surface?: Record<string, unknown> | null }> = []

  beforeEach(() => {
    events = []
    setCurrentRightStageSessionKey('sess-ui')
    rightStageStore.hideAll()
    const handler = (e: Event) => {
      events.push((e as CustomEvent).detail)
    }
    window.addEventListener(STAGE_SET_APPLIED_EVENT, handler)
    ;(globalThis as unknown as { __evHandler?: EventListener }).__evHandler = handler
  })

  afterEach(() => {
    const handler = (globalThis as unknown as { __evHandler?: EventListener }).__evHandler
    if (handler) window.removeEventListener(STAGE_SET_APPLIED_EVENT, handler)
    setCurrentRightStageSessionKey('')
  })

  it('stamps the owner session key onto the dispatched artifacts payload', () => {
    const ok = applyStageSetPayload(
      {
        action: 'show',
        surface: {
          kind: 'artifacts',
          data: { items: [{ type: 'file', path: 'outputs/x.md' }] },
        },
      },
      { sessionKey: 'sess-owner' },
    )
    expect(ok).toBe(true)
    expect(events.length).toBe(1)
    expect(events[0]?.surface?.sessionKey).toBe('sess-owner')
  })

  it('keeps an explicit surface session key (does not overwrite)', () => {
    applyStageSetPayload(
      {
        action: 'show',
        surface: {
          kind: 'artifacts',
          sessionKey: 'sess-explicit',
          data: { items: [] },
        },
      },
      { sessionKey: 'sess-owner' },
    )
    expect(events[0]?.surface?.sessionKey).toBe('sess-explicit')
  })

  it('leaves sessionKey undefined when the event has no owner', () => {
    applyStageSetPayload({
      action: 'show',
      surface: { kind: 'artifacts', data: { items: [] } },
    })
    expect(events[0]?.surface?.sessionKey).toBeUndefined()
  })
})
