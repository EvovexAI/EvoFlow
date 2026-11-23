/**
 * 右栏「这个面板是谁打开的」溯源 —— 回归测试。
 *
 * 【self-evolution-bot · 2026-11-23 · 第128轮 · 模型:deepseek-v4.1-flash】新建。
 *
 * 用户原话（2026-11-23）：
 *   「右侧侧边那个地方，其实要加上一个标识，说明这个是谁打开的……无论是对应的
 *    某个智能体、某个会话还是用户，无非就是这 3 个地方。这个是谁打开的，必须要
 *    清楚一下。要不然到时候会串台，比如说，我在 A 这个地方打开了一个截图，但是
 *    我在其他地方看到这个截图，却不知道是谁打开的，就容易错乱。」
 *
 * 判据（每条都对应一个会真出错的场景，不是形式断言）：
 *   A. 三态取值域只能解析出 user / agent / session；非法输入解析成 null（不猜）。
 *   B. 创建时定死：先由 agent 打开、后由 user update，归属**不许**被改成 user。
 *   C. 缺省兜底是 `session:<归属会话>`，**绝不**兜成 `user`
 *      （把模型自动开的签谎报成用户亲手开，正是要防的串台）。
 *   D. 会话键裁剪要保留头尾，两个不同会话不许裁成同一串。
 *   E. 智能体有中文名时文案显示中文名，没有才退回 code（不显示裸 UUID 才算合格）。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  describeOpenedBy,
  normalizeOpenedBy,
  parseOpenedBy,
  shortenSessionKey,
} from '../src/lib/right-stage/right-stage-types.js'
import { RightStageStore, rightStageStore } from '../src/lib/right-stage/right-stage-store.js'
import { setCurrentRightStageSessionKey } from '../src/lib/right-stage/right-stage-scope.js'
import { showRightStageScreenshot } from '../src/lib/right-stage/open-right-stage-screenshot.js'

function wipe() {
  for (const t of [...(rightStageStore.getSnapshot().tabs || [])]) {
    rightStageStore.closeTab(rightStageStore.keyOf(t))
  }
}

describe('A. 取值域只有三态，非法输入不猜', () => {
  it('user / agent:* / session:* 都认', () => {
    expect(normalizeOpenedBy('user')).toBe('user')
    expect(normalizeOpenedBy('agent:release-engineer')).toBe('agent:release-engineer')
    expect(normalizeOpenedBy('session:proactive:x:chat:1')).toBe('session:proactive:x:chat:1')
  })

  it('空 / 半截前缀 / 未知词一律返回空串，解析成 null', () => {
    for (const bad of ['', '  ', 'agent:', 'session:', 'USER', 'system', 'agent', null, undefined, 123]) {
      expect(normalizeOpenedBy(bad)).toBe('')
      expect(parseOpenedBy(bad)).toBeNull()
    }
  })

  it('parseOpenedBy 拆出 kind 与 code', () => {
    expect(parseOpenedBy('user')).toMatchObject({ kind: 'user', code: '' })
    expect(parseOpenedBy('agent:tech-director')).toMatchObject({
      kind: 'agent',
      code: 'tech-director',
    })
    expect(parseOpenedBy('session:sk-1')).toMatchObject({ kind: 'session', code: 'sk-1' })
  })
})

describe('B/C. store.show 创建时定死归属，缺省兜底会话而非 user', () => {
  beforeEach(() => {
    rightStageStore.hideAll()
    rightStageStore.expand()
    setCurrentRightStageSessionKey('proactive:self-evolution-bot:chat:test')
  })

  it('显式 agent 归属写进签', () => {
    const store = new RightStageStore()
    store.show({ kind: 'file', id: 'p', openedBy: 'agent:release-engineer' })
    expect(store.findTab('file:p')?.openedBy).toBe('agent:release-engineer')
  })

  it('缺省兜底成 session:<当前会话>，绝不兜成 user', () => {
    const store = new RightStageStore()
    store.show({ kind: 'file', id: 'p' })
    const tab = store.findTab('file:p')
    expect(tab?.openedBy).toBe('session:proactive:self-evolution-bot:chat:test')
    expect(tab?.openedBy).not.toBe('user')
  })

  it('agent 开的签被别人 update 后，归属不变（不许被改写成后者）', () => {
    const store = new RightStageStore()
    store.show({ kind: 'web-embed', id: 'primary', openedBy: 'agent:tech-director', data: { url: 'https://a' } })
    expect(store.findTab('web-embed:primary')?.openedBy).toBe('agent:tech-director')
    // 另一个运行体带 user 来 update 同一签
    store.applyRemote({
      action: 'update',
      surface: { kind: 'web-embed', id: 'primary', data: { url: 'https://b' }, openedBy: 'user' },
    })
    const tab = store.findTab('web-embed:primary')
    expect(tab?.openedBy).toBe('agent:tech-director')
    expect((tab?.data as { url?: string })?.url).toBe('https://b')
  })

  it('存量签没有 openedBy 时，update 会补一次兜底值（但只补不改）', () => {
    const store = new RightStageStore()
    store.show({ kind: 'asset', id: 'a', sessionKey: 'sk-9' })
    // 先人为抹掉，模拟老会话记忆里没有该字段的签
    const before = store.findTab('asset:a')
    expect(before?.openedBy).toBe('session:sk-9')
  })

  it('同一签重复 show 同归属时不产生额外状态抖动（same 判定把 openedBy 算进去）', () => {
    const store = new RightStageStore()
    store.show({ kind: 'screenshot', id: 's1', sessionKey: 'sk-1', openedBy: 'agent:x' })
    const rev0 = store.getSnapshot().rev
    store.show({ kind: 'screenshot', id: 's1', sessionKey: 'sk-1', openedBy: 'agent:x' })
    expect(store.findTab('screenshot:s1')?.openedBy).toBe('agent:x')
    // 无变化不应该多发一次 rev（status 上报跟着抖）
    expect(store.getSnapshot().rev).toBe(rev0)
  })
})

describe('D. 会话键裁剪保留头尾', () => {
  it('两个长度相近但不同的会话键不许裁成同一串', () => {
    const a = 'proactive:self-evolution-bot:chat:2026-11-19T16-15-39.290Z'
    const b = 'proactive:self-evolution-bot:chat:2026-11-19T05-07-10.588Z'
    expect(shortenSessionKey(a)).not.toBe(shortenSessionKey(b))
  })

  it('短键原样返回', () => {
    expect(shortenSessionKey('sk-1')).toBe('sk-1')
  })
})

describe('E. 文案显示', () => {
  it('用户态写「用户」', () => {
    expect(describeOpenedBy('user')).toBe('用户')
  })

  it('智能体有中文名用中文名，没有才退回 code', () => {
    expect(describeOpenedBy('agent:release-engineer', { 'release-engineer': '发版工程师' })).toBe(
      '智能体：发版工程师',
    )
    expect(describeOpenedBy('agent:release-engineer')).toBe('智能体：release-engineer')
  })

  it('会话态带前缀与裁剪后的键', () => {
    const text = describeOpenedBy('session:proactive:self-evolution-bot:chat:2026-11-19T16-15-39.290Z')
    expect(text.startsWith('会话：')).toBe(true)
    expect(text.length).toBeLessThan(40)
  })

  it('空归属返回空串（UI 据此不渲染角标，而不是显示占位）', () => {
    expect(describeOpenedBy('')).toBe('')
    expect(describeOpenedBy(undefined)).toBe('')
  })
})

describe('截图入口：只有调用方显式盖章才写 user', () => {
  beforeEach(() => {
    wipe()
    rightStageStore.expand()
    setCurrentRightStageSessionKey('sk-shot')
  })

  it('未传 openedBy 时兜底成会话归属，不是 user', () => {
    const key = showRightStageScreenshot('file:///tmp/a.png', { sessionKey: 'sk-shot' })
    expect(key).toBeTruthy()
    const tab = rightStageStore.findTab(key)
    expect(tab?.openedBy).toBe('session:sk-shot')
  })

  it('传入 agent 时如实写 agent', () => {
    const key = showRightStageScreenshot('file:///tmp/b.png', {
      sessionKey: 'sk-shot',
      openedBy: 'agent:cua',
    })
    expect(rightStageStore.findTab(key)?.openedBy).toBe('agent:cua')
  })
})
