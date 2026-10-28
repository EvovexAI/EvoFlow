/**
 * 右栏 vs 对话右上角状态卡（ChatSummary）优先级。
 *
 * 右栏占宽展开时，平台/产物通知不得自动撑开摘要卡（摘要与专用侧栏互斥，
 * 一撑开就会 collapse 右栏）。条目仍可写入，用户手动开摘要时再看。
 */

export type RightStageCollapsedSnap = {
  collapsed?: boolean
} | null | undefined

/** 右栏当前是否占布局宽度（与 tabs 是否为空无关，同 store.isOpen）。 */
export function isRightStageLayoutOpen(snap: RightStageCollapsedSnap): boolean {
  if (!snap) return false
  return snap.collapsed !== true
}
