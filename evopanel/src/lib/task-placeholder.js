/** 与 backend plan_session_task.DEFAULT_PLAN_PLACEHOLDER_* 对齐，仅用于 UI 过滤系统占位文案。 */

export const PLAN_PLACEHOLDER_DESCRIPTION =
  '协作规划占位任务；调用 plan 工具落库后自动从 Steps 同步子任务。'

export const PLAN_PLACEHOLDER_NAME = '规划任务'

/** @param {unknown} desc */
export function isPlanPlaceholderDescription(desc) {
  return String(desc || '').trim() === PLAN_PLACEHOLDER_DESCRIPTION
}

/**
 * 用户可见的任务描述（过滤系统占位与重复的 plan_goal）。
 * @param {{ description?: string, plan_goal?: string } | null | undefined} task
 */
export function taskDescriptionForDisplay(task) {
  const desc = String(task?.description || '').trim()
  if (!desc || isPlanPlaceholderDescription(desc)) return ''
  const goal = String(task?.plan_goal || '').trim()
  if (goal && desc === goal) return ''
  return desc
}
