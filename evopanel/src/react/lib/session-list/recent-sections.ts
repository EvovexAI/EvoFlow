import type { ShellSidebarSyncRow, ShellWorkspaceGroup } from './types.js'
import { isSpecialWorkspaceGroupKey } from './workspace-groups.js'

export type RecentWorkspaceSection = {
  key: string
  label: string
  rows: ShellSidebarSyncRow[]
  avatarAgentCode: null
  /** 已注册但没有任何会话（新建工作空间后立即显示，避免先去下拉里选中） */
  empty?: boolean
}

/**
 * 侧栏「任务」Tab 的按工作区分组。
 *
 * 显式补上「已注册但暂无会话」的工作区，否则新建工作空间后左侧列表不会出现，
 * 必须先到顶部下拉里选中才看得到。
 * 只有「单组且有会话」时才退化成平铺，保持原有单工作区体验。
 *
 * @param rows 已按筛选条件过滤的会话行
 * @param groups 侧栏工作区分组（含 registeredWorkspacePaths 合并出的空组）
 * @param opts.searching 搜索中不显示空组，避免噪音
 */
export function buildWorkspaceRecentSections(
  rows: ShellSidebarSyncRow[],
  groups: ShellWorkspaceGroup[],
  opts: { searching?: boolean } = {},
): RecentWorkspaceSection[] | null {
  const list = Array.isArray(rows) ? rows : []
  const groupList = Array.isArray(groups) ? groups : []
  const searching = !!opts.searching
  const labelByKey = new Map<string, string>()
  const order: string[] = []
  for (const g of groupList) {
    const key = String(g.workspaceKey || '').trim()
    if (!key) continue
    if (!labelByKey.has(key)) order.push(key)
    labelByKey.set(key, String(g.label || '').trim() || key)
  }

  const byKey = new Map<string, RecentWorkspaceSection>()
  for (const row of list) {
    const key = String(row.workspaceKey || '').trim() || '__unbound__'
    const entry = byKey.get(key) || {
      key,
      label: labelByKey.get(key) || String(row.workspaceLabel || '').trim() || key,
      rows: [],
      avatarAgentCode: null,
    }
    entry.rows.push(row)
    byKey.set(key, entry)
  }

  // 已注册但零会话的工作区也要成组展示（新建工作空间后立即出现在列表里）
  if (!searching) {
    for (const g of groupList) {
      const key = String(g.workspaceKey || '').trim()
      if (!key || isSpecialWorkspaceGroupKey(key)) continue
      if (byKey.has(key)) continue
      byKey.set(key, {
        key,
        label: String(g.label || '').trim() || key,
        rows: [],
        avatarAgentCode: null,
        empty: true,
      })
    }
  }

  // 按侧栏分组顺序稳定排序（组顺序已由 stabilizeShellWorkspaceGroupOrder 锁定）
  const sections: RecentWorkspaceSection[] = []
  const seen = new Set<string>()
  for (const key of order) {
    const section = byKey.get(key)
    if (!section) continue
    sections.push(section)
    seen.add(key)
  }
  for (const [key, section] of byKey) {
    if (seen.has(key)) continue
    sections.push(section)
  }

  if (sections.length === 0) return null
  // 单组且有会话：平铺（原行为）；单组为空、或多组：显示组头
  if (sections.length <= 1 && sections[0].rows.length > 0) return null
  return sections
}
