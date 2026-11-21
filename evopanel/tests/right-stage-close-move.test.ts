/**
 * 右栏「关单个签」「调换位置」必须真的作用在 store 上，且判据可反证。
 *
 * 【self-evolution-bot · 2026-11-20 · 第101轮 · 模型:deepseek-v4.1-flash-1017】
 * 改了什么：新建本测试。
 * 为什么：后端加了 ui.close / ui.move 之后，如果前端 SSE 与工具 result 两条通道
 *   没有对应分发，动作就是「发得出去、屏幕不动」——本轮 activate 已经撞过这个坑
 *   （网关归一化吞掉 key → 前端静默 return false）。
 * 判据：
 *   - close：tabCount 减 1，被关的 key 消失，其它签原样保留；
 *   - move：tabCount 不变，两个签的先后顺序互换；
 *   - 两者都不许退化成 hide（hide 是整栏收起，签还在）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { applyRightStageAgUiCustom } from '../src/lib/right-stage/right-stage-agui.js'
import { rightStageStore } from '../src/lib/right-stage/right-stage-store.js'

function reset() {
  // 清掉所有签，保证每条用例从空开始
  const snap = rightStageStore.getSnapshot()
  for (const t of [...(snap.tabs || [])]) {
    rightStageStore.closeTab(rightStageStore.keyOf(t))
  }
}

function openShell(id: string, path: string, title: string) {
  rightStageStore.show({
    kind: 'shell-page',
    id,
    title,
    layout: 'wide',
    data: { path },
  })
}

describe('right-stage close / move 分发', () => {
  beforeEach(() => {
    reset()
  })
  afterEach(() => {
    reset()
  })

  it('close 只删那一个签，其它签保留', () => {
    openShell('a', '/a', 'A')
    openShell('b', '/b', 'B')
    openShell('c', '/c', 'C')
    const before = rightStageStore.getSnapshot().tabs.map((t) => rightStageStore.keyOf(t))
    expect(before.length).toBe(3)

    const ok = applyRightStageAgUiCustom('right_stage', {
      action: 'close',
      surface: null,
      key: 'shell-page:b',
    })
    expect(ok).toBe(true)

    const after = rightStageStore.getSnapshot().tabs.map((t) => rightStageStore.keyOf(t))
    expect(after.length).toBe(2)
    expect(after).not.toContain('shell-page:b')
    expect(after).toContain('shell-page:a')
    expect(after).toContain('shell-page:c')
  })

  it('close 不存在的签必须返回 false，不许假装成功', () => {
    openShell('a', '/a', 'A')
    const ok = applyRightStageAgUiCustom('right_stage', {
      action: 'close',
      surface: null,
      key: 'shell-page:not-there',
    })
    expect(ok).toBe(false)
    expect(rightStageStore.getSnapshot().tabs.length).toBe(1)
  })

  it('close 缺 key 返回 false', () => {
    openShell('a', '/a', 'A')
    const ok = applyRightStageAgUiCustom('right_stage', { action: 'close', surface: null })
    expect(ok).toBe(false)
    expect(rightStageStore.getSnapshot().tabs.length).toBe(1)
  })

  it('move 只改顺序，不增不删', () => {
    openShell('a', '/a', 'A')
    openShell('b', '/b', 'B')
    openShell('c', '/c', 'C')
    const before = rightStageStore.getSnapshot().tabs.map((t) => rightStageStore.keyOf(t))
    expect(before).toEqual(['shell-page:a', 'shell-page:b', 'shell-page:c'])

    const ok = applyRightStageAgUiCustom('right_stage', {
      action: 'move',
      surface: null,
      key: 'shell-page:c',
      target: 'shell-page:a',
    })
    expect(ok).toBe(true)

    const after = rightStageStore.getSnapshot().tabs.map((t) => rightStageStore.keyOf(t))
    expect(after.length).toBe(3)
    expect(after).toEqual(['shell-page:c', 'shell-page:a', 'shell-page:b'])
  })

  it('move 缺 target 返回 false（不许发必然无效果的指令）', () => {
    openShell('a', '/a', 'A')
    openShell('b', '/b', 'B')
    const before = rightStageStore.getSnapshot().tabs.map((t) => rightStageStore.keyOf(t))
    const ok = applyRightStageAgUiCustom('right_stage', {
      action: 'move',
      surface: null,
      key: 'shell-page:b',
    })
    expect(ok).toBe(false)
    const after = rightStageStore.getSnapshot().tabs.map((t) => rightStageStore.keyOf(t))
    expect(after).toEqual(before)
  })

  it('close 不会被当成 hide：签被真删掉而不是只收起', () => {
    openShell('a', '/a', 'A')
    openShell('b', '/b', 'B')
    applyRightStageAgUiCustom('right_stage', {
      action: 'close',
      surface: null,
      key: 'shell-page:a',
    })
    const snap = rightStageStore.getSnapshot()
    // hide 的语义是 collapsed=true 但 tabs 还在；close 必须让签从 tabs 里消失
    expect(snap.tabs.map((t) => rightStageStore.keyOf(t))).not.toContain('shell-page:a')
  })
})
