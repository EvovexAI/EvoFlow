/** plan 工具入参形状（goal + steps）；无其它模块依赖，供 tool-display / plan-from-task 共用。 */

/** @param {unknown} args */
export function looksLikePlanToolArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false
  const goal = String(args.goal || '').trim()
  let steps = args.steps
  if (typeof steps === 'string' && steps.trim().startsWith('[')) {
    try {
      steps = JSON.parse(steps)
    } catch {
      steps = null
    }
  }
  return !!(goal && Array.isArray(steps) && steps.length > 0)
}
