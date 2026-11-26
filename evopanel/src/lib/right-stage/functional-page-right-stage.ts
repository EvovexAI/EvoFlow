/**
 * 功能页（知识库 / 工作流 / 自动化…）全局右栏可见性。
 *
 * 对话里打开的签（文件 / 工作流 / 员工过程 / web-embed…）不得带到功能页；
 * 功能页右栏只服务小V（及将来明确挂在功能页的 kind）。
 */
import { normalizeRightStageKind, type RightStageSurface } from './right-stage-types.js'

/** 允许出现在功能页 GlobalRightStageHost 上的 kind。 */
export const FUNCTIONAL_PAGE_RIGHT_STAGE_KINDS = new Set<string>(['xiaomi'])

export function isFunctionalPageRightStageKind(kind: string | null | undefined): boolean {
  const k = normalizeRightStageKind(String(kind || '').trim())
  return Boolean(k && FUNCTIONAL_PAGE_RIGHT_STAGE_KINDS.has(k))
}

export function filterTabsForFunctionalPage(
  tabs: readonly RightStageSurface[] | null | undefined,
): RightStageSurface[] {
  return (tabs || []).filter((t) => isFunctionalPageRightStageKind(t?.kind))
}

export function tabKeyOfSurface(tab: RightStageSurface): string {
  const kind = normalizeRightStageKind(tab.kind) || String(tab.kind || '').trim()
  const id = String(tab.id || 'primary').trim() || 'primary'
  return `${kind}:${id}`
}

/** 功能页用的 activeKey：仍可见则保留，否则落到最后一张可见签。 */
export function resolveFunctionalPageActiveKey(
  tabs: readonly RightStageSurface[],
  activeKey: string | null | undefined,
): string | null {
  const visible = filterTabsForFunctionalPage(tabs)
  if (visible.length === 0) return null
  const want = String(activeKey || '').trim()
  if (want && visible.some((t) => tabKeyOfSurface(t) === want)) return want
  return tabKeyOfSurface(visible[visible.length - 1]!)
}
