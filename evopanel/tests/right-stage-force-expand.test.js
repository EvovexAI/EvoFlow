import { describe, it, expect, beforeEach } from 'vitest'
import { rightStageStore } from '../src/lib/right-stage/right-stage-store.js'
import { openEmployeeProcessInRightStage } from '../src/lib/right-stage/open-employee-process-stage.js'
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
