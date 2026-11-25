import type { RightStageSurface } from './right-stage-types.js'
import { scopeOfKind } from './right-stage-scope.js'
import { isTaskCenterStageSessionKey } from './task-center-stage-key.js'

/**
 * 有归属 → 只在匹配会话显示。
 * 无归属：
 *   - workspace 级（write / xiaomi / …）→ 仍可见（本来就跨会话共享）
 *   - session 级 → 隐藏（截图/文件/web-embed/浏览器… 宁可少看见，不可串台）
 * 当前 UI 会话为空（新建草稿瞬间）时：只保留真正的 workspace 级标签。
 * task-center:* 仅任务详情宿主使用，对话侧栏永不展示。
 */
export function isRightStageTabVisibleForSession(
  tab: RightStageSurface,
  sessionKey: string | null | undefined,
): boolean {
  const tabSk = String(tab.sessionKey || '').trim()
  if (isTaskCenterStageSessionKey(tabSk)) return false
  const sk = String(sessionKey || '').trim()
  if (!sk) return scopeOfKind(tab.kind) === 'workspace'
  // 会话级无归属：一律不放行。旧规则 `if (!tabSk) return true` 会让冷启动/
  // applyRemote 丢 sessionKey 写出的孤儿签出现在每一个对话的右栏（侧边串台）。
  if (!tabSk) return scopeOfKind(tab.kind) === 'workspace'
  return tabSk === sk
}

export function filterRightStageTabsForSession(
  tabs: RightStageSurface[],
  sessionKey: string | null | undefined,
): RightStageSurface[] {
  return (tabs || []).filter((t) => isRightStageTabVisibleForSession(t, sessionKey))
}
