import { describe, it, expect } from 'vitest'
import {
  filterTabsForFunctionalPage,
  isFunctionalPageRightStageKind,
  resolveFunctionalPageActiveKey,
} from '../src/lib/right-stage/functional-page-right-stage.ts'

describe('functional page right-stage filter', () => {
  it('only allows xiaomi on functional pages', () => {
    expect(isFunctionalPageRightStageKind('xiaomi')).toBe(true)
    expect(isFunctionalPageRightStageKind('employeeProcess')).toBe(false)
    expect(isFunctionalPageRightStageKind('collab-workflow')).toBe(false)
    expect(isFunctionalPageRightStageKind('file')).toBe(false)
    expect(isFunctionalPageRightStageKind('web-embed')).toBe(false)
    expect(isFunctionalPageRightStageKind('shell-page')).toBe(false)
  })

  it('strips chat tabs so knowledge/workflow pages do not inherit them', () => {
    const tabs = [
      { id: 'global', kind: 'xiaomi', title: '小V', data: {} },
      { id: 'process:live:a', kind: 'employeeProcess', title: '研发', data: {} },
      { id: 'primary', kind: 'collab-workflow', title: '工作流', data: {} },
      { id: 'a.txt', kind: 'file', title: 'a.txt', data: {} },
    ]
    const visible = filterTabsForFunctionalPage(tabs)
    expect(visible.map((t) => t.kind)).toEqual(['xiaomi'])
  })

  it('resolveFunctionalPageActiveKey falls back when active is a chat tab', () => {
    const tabs = [
      { id: 'global', kind: 'xiaomi', title: '小V', data: {} },
      { id: 'wf', kind: 'collab-workflow', title: '流', data: {} },
    ]
    expect(resolveFunctionalPageActiveKey(tabs, 'collab-workflow:wf')).toBe('xiaomi:global')
    expect(resolveFunctionalPageActiveKey(tabs, 'xiaomi:global')).toBe('xiaomi:global')
    expect(resolveFunctionalPageActiveKey(tabs.slice(1), 'collab-workflow:wf')).toBe(null)
  })
})
