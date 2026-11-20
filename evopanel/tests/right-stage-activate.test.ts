/**
 * 【self-evolution-bot · 2026-11-20 · 第100轮 · 模型:deepseek-v4.1-flash-1017】
 * 改了什么：新增门禁——右栏必须支持「切到用户已开的某个标签页」，且切签**不得**
 *   新建签、不得关掉用户的其它签（tabCount 前后相等）、不得改写标签内容。
 * 为什么（用户原话）：「你要知道当前是哪一个，然后怎么去切换到哪一个要处理好。」
 *   改动前只有 show/update/hide：想让人看回某页只能重新 show，
 *   而 show 会把同一份东西开成第二个签 —— 正是用户担心的「我在右栏拉开的东西被弄乱」。
 *
 * 判据（可反证）：
 * - activate 后 activeKey 变成目标 key。
 * - tabCount 不变（用户已开的签一个不少）。
 * - 目标签的 data / title 不被改写（切签 ≠ 刷新内容）。
 * - 目标 key 不存在时不动 activeKey（不能把用户视线丢到不存在的签上）。
 */

import { describe, expect, it, beforeEach, vi } from 'vitest'

vi.mock('../src/lib/gateway-json.js', () => ({
  gatewayJson: vi.fn(),
  gatewayFetch: vi.fn(async () => ({ ok: true })),
}))

const { RightStageStore } = await import('../src/lib/right-stage/right-stage-store.ts')
const { applyRightStageAgUiCustom } = await import('../src/lib/right-stage/right-stage-agui.ts')

type Store = InstanceType<typeof RightStageStore>

function seed(store: Store) {
  store.show({ kind: 'employeeProcess', id: 'primary', title: '审核员', data: { agentCode: 'reviewer' } })
  store.show({ kind: 'shell-page', id: 'tasks', title: '任务', data: { path: '/tasks' } })
  store.show({ kind: 'web-embed', id: 'primary', title: '网页', data: { url: 'https://example.com' } })
}

describe('right-stage activate（切到已有标签）', () => {
  let store: Store

  beforeEach(() => {
    store = new RightStageStore()
  })

  it('切到已存在的标签：activeKey 变，tabCount 不变', () => {
    seed(store)
    const before = store.getSnapshot()
    expect(before.tabs.length).toBe(3)
    const target = 'shell-page:tasks'
    expect(before.activeKey).not.toBe(target)

    store.activateTab(target)

    const after = store.getSnapshot()
    expect(after.activeKey).toBe(target)
    expect(after.tabs.length).toBe(before.tabs.length)
  })

  it('切签不改写目标签的标题与内容', () => {
    seed(store)
    const target = 'shell-page:tasks'
    const beforeTab = store.getSnapshot().tabs.find((t) => t.key === target)
    store.activateTab(target)
    const afterTab = store.getSnapshot().tabs.find((t) => t.key === target)
    expect(afterTab?.title).toBe(beforeTab?.title)
    expect(afterTab?.data).toEqual(beforeTab?.data)
  })

  it('目标 key 不存在时不动 activeKey（不把用户视线丢到空签）', () => {
    seed(store)
    const before = store.getSnapshot().activeKey
    store.activateTab('nope:missing')
    expect(store.getSnapshot().activeKey).toBe(before)
  })
})

describe('SSE 实时通路（right_stage action=activate）', () => {
  it('custom 流带 key 时能切签，且不要求 surface.kind', async () => {
    const { rightStageStore } = await import('../src/lib/right-stage/right-stage-store.ts')
    rightStageStore.closeAllTabs()
    rightStageStore.show({ kind: 'employeeProcess', id: 'primary', title: '审核员', data: { agentCode: 'reviewer' } })
    rightStageStore.show({ kind: 'shell-page', id: 'tasks', title: '任务', data: { path: '/tasks' } })
    const before = rightStageStore.getSnapshot()
    const target = 'employeeProcess:primary'
    expect(before.activeKey).not.toBe(target)

    const handled = applyRightStageAgUiCustom('right_stage', { action: 'activate', key: target })

    const after = rightStageStore.getSnapshot()
    expect(handled).toBe(true)
    expect(after.activeKey).toBe(target)
    expect(after.tabs.length).toBe(before.tabs.length)
  })

  it('缺 key 时返回 false，不动现场', async () => {
    const { rightStageStore } = await import('../src/lib/right-stage/right-stage-store.ts')
    rightStageStore.closeAllTabs()
    rightStageStore.show({ kind: 'shell-page', id: 'tasks', title: '任务', data: { path: '/tasks' } })
    const before = rightStageStore.getSnapshot()
    const handled = applyRightStageAgUiCustom('right_stage', { action: 'activate' })
    expect(handled).toBe(false)
    expect(rightStageStore.getSnapshot().activeKey).toBe(before.activeKey)
    expect(rightStageStore.getSnapshot().tabs.length).toBe(before.tabs.length)
  })
})

describe('工具 result 回放通道（surface=null 的 activate 不能被当成收起）', () => {
  it('buildStageSetPayload 解析 activate 后，apply 不会收起右栏', async () => {
    const { buildStageSetPayload } = await import('../src/lib/right-stage/right-stage-agui.ts')
    const { rightStageStore } = await import('../src/lib/right-stage/right-stage-store.ts')
    rightStageStore.closeAllTabs()
    rightStageStore.show({ kind: 'employeeProcess', id: 'primary', title: '审核员', data: { agentCode: 'reviewer' } })
    rightStageStore.show({ kind: 'shell-page', id: 'tasks', title: '任务', data: { path: '/tasks' } })
    const before = rightStageStore.getSnapshot()
    expect(before.activeKey).not.toBe('employeeProcess:primary')

    // 后端 ui.activate 的返回长这样（surface 为 null）
    const payload = buildStageSetPayload(
      '{"action":"activate","key":"employeeProcess:primary"}',
      '{"ok":true,"action":"activate","key":"employeeProcess:primary","surface":null}',
    )
    expect(payload?.action).toBe('activate')
    expect(payload?.key).toBe('employeeProcess:primary')

    const handled = applyRightStageAgUiCustom('right_stage', payload)
    const after = rightStageStore.getSnapshot()
    expect(handled).toBe(true)
    expect(after.activeKey).toBe('employeeProcess:primary')
    // 反证：绝不能把面板收起（hide 会把 collapsed 置 true / tabs 清掉）
    expect(after.tabs.length).toBe(before.tabs.length)
    expect(after.collapsed).toBe(false)
  })
})
