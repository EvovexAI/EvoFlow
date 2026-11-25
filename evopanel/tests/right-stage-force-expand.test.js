import { describe, it, expect, beforeEach } from 'vitest'
import { rightStageStore } from '../src/lib/right-stage/right-stage-store.js'
import {
  openDeptGroupWakeProcessInRightStage,
  openEmployeeProcessInRightStage,
} from '../src/lib/right-stage/open-employee-process-stage.js'
import { openShellPageInRightStage } from '../src/lib/right-stage/open-shell-page-stage.js'

function resetStore() {
  // 清空 tabs + 折叠态：走一次空内存导入
  rightStageStore.importSessionMemory(null, { collapsedWhenNoMemory: true })
}

describe('right stage user-explicit open vs collapse lock', () => {
  beforeEach(() => {
    resetStore()
  })

  it('openEmployeeProcessInRightStage forceExpand:true expands a collapsed (user-locked) panel', () => {
    rightStageStore.collapse() // 用户收起锁：userCollapsed = true
    expect(rightStageStore.getSnapshot().collapsed).toBe(true)
    const id = openEmployeeProcessInRightStage(
      { taskId: 'live:emp-a', agentCode: 'emp-a', roleName: '员工A', title: '员工A' },
      { sessionKey: 'dept:x:chat', forceExpand: true },
    )
    expect(id).toBeTruthy()
    const snap = rightStageStore.getSnapshot()
    expect(snap.collapsed).toBe(false)
    expect(snap.tabs.some((t) => t.kind === 'employeeProcess' && t.data?.agentCode === 'emp-a')).toBe(
      true,
    )
  })

  it('openEmployeeProcessInRightStage without forceExpand respects the collapse lock (auto-open semantics)', () => {
    rightStageStore.collapse()
    openEmployeeProcessInRightStage(
      { taskId: 'live:emp-b', agentCode: 'emp-b', roleName: '员工B' },
      { sessionKey: 'dept:x:chat' },
    )
    const snap = rightStageStore.getSnapshot()
    expect(snap.collapsed).toBe(true)
    expect(snap.tabs.some((t) => t.data?.agentCode === 'emp-b')).toBe(true)
  })

  it('openShellPageInRightStage forceExpand:true expands a collapsed (user-locked) panel', () => {
    rightStageStore.collapse()
    const id = openShellPageInRightStage(
      {
        path: '/proactive/emp-c',
        mountId: 'employees.detail',
        title: '员工C',
        agentCode: 'emp-c',
      },
      { sessionKey: 'dept:x:chat', forceExpand: true },
    )
    expect(id).toBeTruthy()
    const snap = rightStageStore.getSnapshot()
    expect(snap.collapsed).toBe(false)
    expect(snap.tabs.some((t) => t.kind === 'shell-page')).toBe(true)
  })

  it('openShellPageInRightStage without forceExpand keeps the panel collapsed', () => {
    rightStageStore.collapse()
    openShellPageInRightStage(
      { path: '/proactive/emp-d', mountId: 'employees.detail', title: '员工D' },
      { sessionKey: 'dept:x:chat' },
    )
    expect(rightStageStore.getSnapshot().collapsed).toBe(true)
  })

  it('importSessionMemory of a fresh session leaves collapsed=true without pinning beyond store semantics', () => {
    rightStageStore.importSessionMemory(null, { collapsedWhenNoMemory: true })
    const snap = rightStageStore.getSnapshot()
    expect(snap.collapsed).toBe(true)
    expect(snap.tabs).toHaveLength(0)
  })

  it('openDeptGroupWakeProcessInRightStage writes tab but does not auto-expand (user opens process)', () => {
    rightStageStore.collapse()
    const id = openDeptGroupWakeProcessInRightStage({
      deptId: 'rd',
      agentCode: 'dev-a',
      roleName: '研发A',
      shellSessionKey: 'dept:rd:chat',
      employeeSessionKey: 'proactive:dev-a:chat:dept-rd',
      depth: 0,
    })
    expect(id).toBeTruthy()
    const snap = rightStageStore.getSnapshot()
    // 群聊唤醒只预写签，不抢开右栏；用户点「查看实时过程」再 forceExpand
    expect(snap.collapsed).toBe(true)
    const tab = snap.tabs.find((t) => t.kind === 'employeeProcess')
    expect(tab?.data?.agentCode).toBe('dev-a')
    expect(tab?.data?.employeeSessionKey).toBe('proactive:dev-a:chat:dept-rd')
    expect(tab?.sessionKey).toBe('dept:rd:chat')
  })

  it('openDeptGroupWakeProcessInRightStage nested wake respects collapse lock', () => {
    rightStageStore.collapse()
    openDeptGroupWakeProcessInRightStage({
      deptId: 'rd',
      agentCode: 'dev-b',
      roleName: '研发B',
      shellSessionKey: 'dept:rd:chat',
      employeeSessionKey: 'proactive:dev-b:chat:dept-rd',
      depth: 1,
    })
    const snap = rightStageStore.getSnapshot()
    expect(snap.collapsed).toBe(true)
    expect(snap.tabs.some((t) => t.data?.agentCode === 'dev-b')).toBe(true)
  })
})

describe('platform CTA → shell-page right stage', () => {
  it('items「查看事项」点开后展开被用户收起的右栏（forceExpand 透传）', async () => {
    resetStore()
    rightStageStore.collapse() // 用户收起锁
    const { activatePlatformFeedbackAction } = await import(
      '../src/lib/right-stage/platform-feedback.ts'
    )
    const ok = activatePlatformFeedbackAction(
      {
        label: '查看事项',
        route: '/tasks?tab=items&focus=it-1',
        openStage: {
          kind: 'shell-page',
          data: {
            path: '/tasks/items',
            route: '/tasks/items',
            mountId: 'items.board',
            focusId: 'it-1',
          },
        },
      },
      {
        domain: 'items',
        action: 'items.create',
        entityId: 'it-1',
        entityLabel: '周五交报告',
        title: '待办',
      },
    )
    const snap = rightStageStore.getSnapshot()
    expect(ok).toBe(true)
    // 回归点：过去 shell-page 分支漏传 forceExpand，collapse 后点按钮只写签不撑开 = 没反应
    expect(snap.collapsed).toBe(false)
    const tab = snap.tabs.find((t) => t.kind === 'shell-page')
    expect(tab?.data?.path).toBe('/tasks/items')
    expect(tab?.data?.mountId).toBe('items.board')
    expect(tab?.data?.focusId).toBe('it-1')
  })
})

/**
 * 【self-evolution-bot · 2026-11-20 · 第91轮 · 模型:deepseek-v4.1-flash-1017】
 * 改了什么：新增这一组用例，锁住 `surface.expand` → `store.show(forceExpand)` 的接线。
 * 为什么：用户要求「用平台工具打开面板给我看」。第91轮实测发现右栏被用户收起后
 * `platform ui.show` 返回 ok:true 但 DOM 里 `.react-chat-right-stage-shell` 根本不存在
 * —— 工具说「已打开」、用户屏幕上什么都没有。根因是 `applyRemote` 调 `show()` 时
 * 从不传 forceExpand。修法是加显式 `expand` 标记，本组用例从 store 层直接证行为，
 * 不靠源码字符串断言。
 */
describe('applyRemote surface.expand 展开语义', () => {
  beforeEach(() => {
    resetStore()
  })

  it('expand:true 会撑开被用户收起的右栏（这是 ui.show 让用户真看见的唯一通道）', () => {
    rightStageStore.collapse()
    expect(rightStageStore.getSnapshot().collapsed).toBe(true)

    rightStageStore.applyRemote({
      action: 'show',
      surface: {
        id: 'primary',
        kind: 'shell-page',
        data: { path: '/tasks' },
        title: '任务',
        expand: true,
      },
    })

    const snap = rightStageStore.getSnapshot()
    expect(snap.collapsed).toBe(false)
    expect(snap.tabs.some((t) => t.kind === 'shell-page')).toBe(true)
  })

  it('不带 expand 时仍尊重收起锁（模型不得抢用户视线）', () => {
    rightStageStore.collapse()

    rightStageStore.applyRemote({
      action: 'show',
      surface: {
        id: 'primary',
        kind: 'shell-page',
        data: { path: '/tasks' },
        title: '任务',
      },
    })

    const snap = rightStageStore.getSnapshot()
    expect(snap.collapsed).toBe(true) // 只写签，不撑开
    expect(snap.tabs.some((t) => t.kind === 'shell-page')).toBe(true)
  })

  it('expand:true 对已有的同键标签也要能撑开（update 分支同口径）', () => {
    rightStageStore.applyRemote({
      action: 'show',
      surface: { id: 'primary', kind: 'shell-page', data: { path: '/tasks' }, title: '任务' },
    })
    rightStageStore.collapse()
    expect(rightStageStore.getSnapshot().collapsed).toBe(true)

    // 同一份 surface（title/data 完全一致）→ store 走 same 早退分支
    rightStageStore.applyRemote({
      action: 'show',
      surface: {
        id: 'primary',
        kind: 'shell-page',
        data: { path: '/tasks' },
        title: '任务',
        expand: true,
      },
    })

    expect(rightStageStore.getSnapshot().collapsed).toBe(false)
  })
})

// 【self-evolution-bot · 2026-11-20 · 第95轮 · 模型:deepseek-v4.1-flash-1017】
// 改了什么：锁住「后台 update 不得抢走用户正在看/正在聊的标签」。
// 为什么：用户场景是「我让另一个 AI 干活、右栏实时显示、我还要接着跟它聊」。
//   实测 chat_send 打开「发版工程师」后约 10 秒 active 自己跳到「任务」，
//   因为 applyRemote 的 update 分支无条件 activeKey = key。续聊当场被打断。
describe('update 分支不得抢走用户已钉住的标签', () => {
  it('用户钉在员工对话上时，别的面板 update 只更新内容不切 active', () => {
    // 先开员工对话并钉住（模拟用户点开 / chat_send 打开）
    rightStageStore.show({
      kind: 'employeeProcess',
      id: 'process:live:release-engineer',
      title: '发版工程师',
      sessionKey: 'proactive:release-engineer:chat:2026-11-18T17-31-25.538Z',
      forceExpand: true,
    })
    rightStageStore.activateTab('employeeProcess:process:live:release-engineer')
    const pinnedKey = rightStageStore.getSnapshot().activeKey
    expect(pinnedKey).toBe('employeeProcess:process:live:release-engineer')

    // 另一个面板刷新（任务页 / 运行中）
    rightStageStore.applyRemote({
      action: 'update',
      surface: { id: 'primary', kind: 'shell-page', data: { path: '/tasks' }, title: '任务' },
    })

    const snap = rightStageStore.getSnapshot()
    // 关键断言：焦点没被抢走，内容仍可更新
    expect(snap.activeKey).toBe(pinnedKey)
    expect(snap.tabs.some((t) => t.kind === 'shell-page')).toBe(true)
  })

  it('显式 expand:true 的 update 仍允许抢焦点（用户明确要求展示）', () => {
    rightStageStore.show({
      kind: 'employeeProcess',
      id: 'process:live:release-engineer',
      title: '发版工程师',
      forceExpand: true,
    })
    rightStageStore.activateTab('employeeProcess:process:live:release-engineer')

    rightStageStore.applyRemote({
      action: 'update',
      surface: {
        id: 'primary',
        kind: 'shell-page',
        data: { path: '/tasks' },
        title: '任务',
        expand: true,
      },
    })

    expect(rightStageStore.getSnapshot().activeKey).toBe('shell-page:primary')
  })
})
