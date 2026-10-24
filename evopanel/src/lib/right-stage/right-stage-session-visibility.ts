import type { RightStageSurface } from './right-stage-types.js'
import { isTaskCenterStageSessionKey } from './task-center-stage-key.js'

/**
 * 无 sessionKey 的旧标签对所有会话可见；有归属则只在匹配会话显示。
 * task-center:* 仅任务详情宿主使用，对话侧栏永不展示（避免无选中会话时串台）。
 */
export function isRightStageTabVisibleForSession(
  tab: RightStageSurface,
  sessionKey: string | null | undefined,
): boolean {
  const tabSk = String(tab.sessionKey || '').trim()
  if (isTaskCenterStageSessionKey(tabSk)) return false
  if (!tabSk) return true
  const sk = String(sessionKey || '').trim()
  if (!sk) return true
  return tabSk === sk
}

export function filterRightStageTabsForSession(
  tabs: RightStageSurface[],
  sessionKey: string | null | undefined,
): RightStageSurface[] {
  return (tabs || []).filter((t) => isRightStageTabVisibleForSession(t, sessionKey))
}
