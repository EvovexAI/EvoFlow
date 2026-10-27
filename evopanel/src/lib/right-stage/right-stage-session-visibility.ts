import type { RightStageSurface } from './right-stage-types.js'
import { scopeOfKind } from './right-stage-scope.js'
import { isTaskCenterStageSessionKey } from './task-center-stage-key.js'

/**
 * 无 sessionKey 的旧标签：在真实会话下仍可见（遗留未打归属）；
 * 有归属则只在匹配会话显示。
 * 当前 UI 会话为空（新建草稿瞬间）时：只保留真正的 workspace 级标签，
 * 进度/壳页等会话级内容一律隐藏，避免串台闪现。
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
  if (!tabSk) return true
  return tabSk === sk
}

export function filterRightStageTabsForSession(
  tabs: RightStageSurface[],
  sessionKey: string | null | undefined,
): RightStageSurface[] {
  return (tabs || []).filter((t) => isRightStageTabVisibleForSession(t, sessionKey))
}
