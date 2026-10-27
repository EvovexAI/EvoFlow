import { afterEach, describe, expect, it } from 'vitest'
import { rightStageStore } from '../src/lib/right-stage/right-stage-store.ts'
import {
  clearRightStageSessionMemory,
  saveRightStageSessionMemory,
  switchRightStageSession,
} from '../src/lib/right-stage/right-stage-session-memory.ts'
import {
  closeRightStageTabsForRemovedEntity,
  tabMatchesRemovedEntity,
} from '../src/lib/right-stage/close-removed-entity-stage.ts'

describe('closeRightStageTabsForRemovedEntity', () => {
  afterEach(() => {
    rightStageStore.hideAll()
    clearRightStageSessionMemory()
  })

  it('matches employee shell-page and employeeProcess tabs', () => {
    expect(
      tabMatchesRemovedEntity(
        {
          kind: 'shell-page',
          id: 'shell:/proactive/emp-94bfd89f',
          title: '值班',
          data: { path: '/proactive/emp-94bfd89f' },
        },
        { domain: 'employees', entityId: 'emp-94bfd89f' },
      ),
    ).toBe(true)

    expect(
      tabMatchesRemovedEntity(
        {
          kind: 'employeeProcess',
          id: 'process:live:emp-94bfd89f',
          title: '值班',
          data: { agentCode: 'emp-94bfd89f' },
        },
        { domain: 'employees', entityId: 'emp-94bfd89f' },
      ),
    ).toBe(true)

    expect(
      tabMatchesRemovedEntity(
        {
          kind: 'shell-page',
          id: 'shell:/proactive/other',
          title: '其他',
          data: { path: '/proactive/other' },
        },
        { domain: 'employees', entityId: 'emp-94bfd89f' },
      ),
    ).toBe(false)
  })

  it('discards live shell-page for deleted employee and does not leave recentClosed', () => {
    rightStageStore.show({
      kind: 'shell-page',
      id: 'shell:/proactive/emp-94bfd89f',
      title: '值班',
      layout: 'wide',
      data: { path: '/proactive/emp-94bfd89f', route: '/proactive/emp-94bfd89f' },
    })
    rightStageStore.show({
      kind: 'shell-page',
      id: 'shell:/proactive',
      title: '员工',
      layout: 'wide',
      data: { path: '/proactive', route: '/proactive' },
    })

    const closed = closeRightStageTabsForRemovedEntity({
      domain: 'employees',
      entityId: 'emp-94bfd89f',
    })

    expect(closed).toBe(1)
    const snap = rightStageStore.getSnapshot()
    expect(snap.tabs.map((t) => t.id)).toEqual(['shell:/proactive'])
    expect(snap.recentClosed.some((e) => e.key.includes('emp-94bfd89f'))).toBe(false)
  })

  it('discards task shell-page on tasks.delete', () => {
    rightStageStore.show({
      kind: 'shell-page',
      id: 'shell:/task/mt-1',
      title: '任务',
      layout: 'wide',
      data: { path: '/task/mt-1' },
    })

    const closed = closeRightStageTabsForRemovedEntity({
      domain: 'tasks',
      entityId: 'mt-1',
    })

    expect(closed).toBe(1)
    expect(rightStageStore.getSnapshot().tabs).toHaveLength(0)
  })

  it('purges matching tabs from other session memory', () => {
    switchRightStageSession('', 'session:a')
    rightStageStore.show({
      kind: 'shell-page',
      id: 'shell:/proactive/emp-gone',
      title: '已删',
      layout: 'wide',
      data: { path: '/proactive/emp-gone' },
    })
    saveRightStageSessionMemory('session:a')

    switchRightStageSession('session:a', 'session:b')
    rightStageStore.hideAll()

    const closed = closeRightStageTabsForRemovedEntity({
      domain: 'employees',
      entityId: 'emp-gone',
    })
    expect(closed).toBe(0)

    switchRightStageSession('session:b', 'session:a')
    expect(
      rightStageStore.getSnapshot().tabs.some((t) => String(t.id).includes('emp-gone')),
    ).toBe(false)
  })
})
