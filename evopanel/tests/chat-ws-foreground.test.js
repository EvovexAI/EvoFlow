import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  isChatWsEventBackground,
  resolveChatEventTarget,
} from '../src/react/lib/chat-ws-foreground.ts'

describe('isChatWsEventBackground', () => {
  it('marks foreign session as background when main UI has a selection', () => {
    expect(
      isChatWsEventBackground({
        eventSk: 'xiaomi-1',
        uiSk: 'main-1',
        xiaomiSk: 'xiaomi-1',
      }),
    ).toBe(true)
  })

  it('keeps matching selection as foreground', () => {
    expect(
      isChatWsEventBackground({
        eventSk: 'main-1',
        uiSk: 'main-1',
        xiaomiSk: 'xiaomi-1',
      }),
    ).toBe(false)
  })

  it('forces Xiaomi events background on empty home selection', () => {
    expect(
      isChatWsEventBackground({
        eventSk: 'xiaomi-1',
        uiSk: '',
        xiaomiSk: 'xiaomi-1',
      }),
    ).toBe(true)
  })

  it('still allows new-session race: empty UI + non-Xiaomi event stays foreground', () => {
    expect(
      isChatWsEventBackground({
        eventSk: 'brand-new',
        uiSk: '',
        xiaomiSk: 'xiaomi-1',
      }),
    ).toBe(false)
  })

  it('treats Xiaomi as foreground only when main UI selected that key', () => {
    expect(
      isChatWsEventBackground({
        eventSk: 'xiaomi-1',
        uiSk: 'xiaomi-1',
        xiaomiSk: 'xiaomi-1',
      }),
    ).toBe(false)
  })
})

// 会话切换竞态回归（真实故障：多开会话反复切换后，对话串台 / AI 回复看不到）。
//
// 根因两层：
//   1) sessionRef.current 的同步 layout effect 声明在「切换会话」layout effect 之后。
//      React layout effect 按声明顺序执行 ⇒ 切会话那一帧 sessionRef 仍是旧会话，
//      事件路由用的 uiSk 过期。
//   2) 事件路由用 uiSk 决定写哪个 runtime，过期的 uiSk 会把 A 的流灌进 B。
//
// 修复：
//   1) sessionRef 同步 effect 上移到切换 effect 之前（use-chat-app-controller.tsx）。
//   2) resolveChatEventTarget 强制「事件只写进自己归属的会话（eventSk）」。
//
// 本组用例锁住第 2 层不变量：无论 uiSk 是否过期，事件都不会写错会话。
describe('resolveChatEventTarget — 事件只写进自己归属的会话', () => {
  it('正常前台：事件归属就是当前会话 → 写当前会话，非后台', () => {
    const r = resolveChatEventTarget({ eventSk: 'sess-A', uiSk: 'sess-A' })
    expect(r.targetSk).toBe('sess-A')
    expect(r.isBackground).toBe(false)
  })

  it('正常后台：事件归属别的会话 → 写事件归属会话，判为后台', () => {
    const r = resolveChatEventTarget({ eventSk: 'sess-A', uiSk: 'sess-B' })
    expect(r.targetSk).toBe('sess-A')
    expect(r.isBackground).toBe(true)
  })

  it('竞态：uiSk 过期仍指向旧会话 → 绝不把事件灌进别的会话', () => {
    // 用户刚点了 sess-B（selectedSessionKey 已是 B），但 sessionRef 还停在 sess-A，
    // 此时 sess-A 的 AI 还在吐 delta。
    for (const uiSk of ['sess-A', 'sess-B', '', 'sess-C']) {
      expect(resolveChatEventTarget({ eventSk: 'sess-A', uiSk }).targetSk).toBe('sess-A')
    }
  })

  it('竞态：事件归属新会话但 uiSk 仍是旧会话 → 写新会话，不污染旧会话', () => {
    // 反向：从 A 切到 B，B 的首帧事件到达，而 uiSk 仍过期指向 A。
    const r = resolveChatEventTarget({ eventSk: 'sess-B', uiSk: 'sess-A' })
    expect(r.targetSk).toBe('sess-B')
    expect(r.isBackground).toBe(true)
  })

  it('无归属信息时才退回 UI 会话', () => {
    expect(resolveChatEventTarget({ eventSk: '', uiSk: 'sess-A' }).targetSk).toBe('sess-A')
    expect(resolveChatEventTarget({ eventSk: '', uiSk: '' }).targetSk).toBe('')
  })

  it('小V 会话在主栏未选中时仍是后台', () => {
    const r = resolveChatEventTarget({
      eventSk: 'xiaomi-1',
      uiSk: 'sess-A',
      xiaomiSk: 'xiaomi-1',
    })
    expect(r.isBackground).toBe(true)
    expect(r.targetSk).toBe('xiaomi-1')
  })
})

describe('会话切换 layout effect 顺序（根因 #1 的不变量）', () => {
  it('sessionRef 同步必须早于「切换会话」layout effect', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/react/chat-app/use-chat-app-controller.tsx'),
      'utf8',
    )
    // React layout effect 按声明顺序执行。sessionRef.current 若晚于切换 effect 写入，
    // 切会话那一帧 uiSk 仍是旧会话 → 事件路由错位 → 对话串台 / 看不到回复。
    const syncIdx = src.indexOf('sessionRef.current = selectedSessionKey')
    const switchIdx = src.indexOf('runSessionSwitchLayoutEffect({')
    expect(syncIdx).toBeGreaterThan(-1)
    expect(switchIdx).toBeGreaterThan(-1)
    expect(syncIdx).toBeLessThan(switchIdx)
  })
})
