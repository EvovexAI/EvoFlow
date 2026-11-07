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
