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
  // 【self-evolution-bot · 2026-11-21 · 第105轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：截图不享受「无归属 → 对所有会话可见」的遗留豁免。
  // 为什么：下面那句 `if (!tabSk) return true` 是为了兼容早期没打归属的标签，
  //   但截图是**用户一眼就能看出串台**的内容（同一张画图出现在别的会话里）。
  //   会话 key 在冷启动/切会话中间态为空时，自动开栏会写出无归属截图标签，
  //   再被这条豁免放行到所有会话。截图宁可少看见，也不能串台。
  if (!tabSk) return tab.kind !== 'screenshot'
  return tabSk === sk
}

export function filterRightStageTabsForSession(
  tabs: RightStageSurface[],
  sessionKey: string | null | undefined,
): RightStageSurface[] {
  return (tabs || []).filter((t) => isRightStageTabVisibleForSession(t, sessionKey))
}
