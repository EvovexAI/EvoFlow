import { describe, expect, it } from 'vitest'
import { buildWorkspaceRecentSections } from '../src/react/lib/session-list/recent-sections.js'

function row(sessionKey, workspaceKey, workspaceLabel = '') {
  return {
    sessionKey,
    title: sessionKey,
    time: '',
    createdAt: 0,
    updatedAt: 0,
    active: false,
    canDelete: true,
    executing: false,
    runningPreviewLine: '',
    hasUnseenRunningUpdate: false,
    isPinned: false,
    pinOrder: 0,
    goalActive: false,
    workspaceKey,
    workspaceLabel,
  }
}

function group(workspaceKey, label, extra = {}) {
  return {
    workspaceKey,
    label,
    path: `D:/work/${label}`,
    sessionCount: 0,
    sessions: [],
    ...extra,
  }
}

describe('buildWorkspaceRecentSections', () => {
  it('keeps the old flat behaviour for a single workspace with sessions', () => {
    const rows = [row('a', 'd:/work/alpha', 'alpha')]
    const groups = [group('d:/work/alpha', 'alpha')]
    expect(buildWorkspaceRecentSections(rows, groups)).toBeNull()
  })

  it('shows a newly registered workspace that has no sessions yet', () => {
    // 新建工作空间后：全局历史里有它，但会话行还没有 → 必须出现在左侧
    const groups = [
      group('d:/work/alpha', 'alpha'),
      group('d:/work/beta', 'beta'),
    ]
    const rows = [row('a', 'd:/work/alpha', 'alpha')]
    const sections = buildWorkspaceRecentSections(rows, groups)
    expect(sections?.map((s) => s.key)).toEqual(['d:/work/alpha', 'd:/work/beta'])
    expect(sections?.find((s) => s.key === 'd:/work/beta')?.rows).toEqual([])
    expect(sections?.find((s) => s.key === 'd:/work/beta')?.empty).toBe(true)
  })

  it('shows a single empty workspace instead of nothing', () => {
    const groups = [group('d:/work/beta', 'beta')]
    const sections = buildWorkspaceRecentSections([], groups)
    expect(sections).toHaveLength(1)
    expect(sections?.[0].key).toBe('d:/work/beta')
    expect(sections?.[0].rows).toEqual([])
  })

  it('hides empty workspaces while searching', () => {
    const groups = [group('d:/work/alpha', 'alpha'), group('d:/work/beta', 'beta')]
    const rows = [row('a', 'd:/work/alpha', 'alpha')]
    const sections = buildWorkspaceRecentSections(rows, groups, { searching: true })
    // 只剩有命中的组
    expect(sections).toBeNull()
  })

  it('skips special groups (unbound / proactive / virtual) when adding empties', () => {
    const groups = [
      group('__unbound__', '默认'),
      group('__proactive__', '智能体员工'),
      group('d:/work/alpha', 'alpha'),
    ]
    const sections = buildWorkspaceRecentSections([], groups)
    expect(sections?.map((s) => s.key)).toEqual(['d:/work/alpha'])
  })

  it('orders sections by sidebar group order', () => {
    const groups = [
      group('d:/work/beta', 'beta'),
      group('d:/work/alpha', 'alpha'),
    ]
    const rows = [row('a', 'd:/work/alpha', 'alpha'), row('b', 'd:/work/beta', 'beta')]
    expect(buildWorkspaceRecentSections(rows, groups)?.map((s) => s.key)).toEqual([
      'd:/work/beta',
      'd:/work/alpha',
    ])
  })

  it('falls back to row workspaceLabel when the group is unknown', () => {
    const rows = [row('a', 'd:/work/x', 'X 项目'), row('b', 'd:/work/y', 'Y 项目')]
    const sections = buildWorkspaceRecentSections(rows, [])
    expect(sections?.map((s) => s.label)).toEqual(['X 项目', 'Y 项目'])
  })

  it('returns null when there is nothing at all', () => {
    expect(buildWorkspaceRecentSections([], [])).toBeNull()
  })
})
