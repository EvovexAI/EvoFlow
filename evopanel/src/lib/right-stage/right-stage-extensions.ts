import { defaultTitleForKind } from './right-stage-types.js'

/** 由顶栏「扩展」菜单手动打开的 Stage（与工作区/思维导图等独立入口区分）。 */
export type UserStageExtensionKind = 'web-embed'

export type UserStageExtensionEntry = {
  kind: UserStageExtensionKind
  label: string
  description: string
}

/** 资讯热榜已从菜单移除；保留浏览器内嵌。扩展应用列表由工具栏动态加载。 */
export const USER_STAGE_EXTENSIONS: UserStageExtensionEntry[] = [
  {
    kind: 'web-embed',
    label: '浏览器',
    description: '输入网址，在右侧内嵌浏览网页',
  },
]

const EXTENSION_KIND_SET = new Set<string>(USER_STAGE_EXTENSIONS.map((e) => e.kind))

export function isUserStageExtensionKind(kind: string | null | undefined): kind is UserStageExtensionKind {
  return !!kind && EXTENSION_KIND_SET.has(kind)
}

export function getUserStageExtensionEntry(
  kind: string | null | undefined,
): UserStageExtensionEntry | null {
  if (!isUserStageExtensionKind(kind)) return null
  return USER_STAGE_EXTENSIONS.find((e) => e.kind === kind) ?? null
}

export function titleForUserStageExtension(kind: UserStageExtensionKind): string {
  return getUserStageExtensionEntry(kind)?.label ?? defaultTitleForKind(kind)
}
