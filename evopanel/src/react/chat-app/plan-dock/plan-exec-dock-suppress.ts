// @ts-nocheck — mechanical P141 extract.
/**
 * Suppress / query plan-exec dock keys for a task (and subCount variants).
 * Extracted from ChatApp.tsx (P141).
 */
export type PlanExecDockSuppressCtx = Record<string, any>

export function isPlanExecDockSuppressed(
  ctx: PlanExecDockSuppressCtx,
  taskId: string,
  subCount: number,
): boolean {
  const tid = ctx.planExecSuppressToken(taskId)
  const key = `${tid}:${subCount}`
  const set = ctx.suppressedPlanExecDockKeysRef.current
  if (set.has(tid) || set.has(key)) return true
  for (const k of set) {
    if (k.startsWith(`${tid}:`)) return true
  }
  return false
}

export function suppressPlanExecDock(ctx: PlanExecDockSuppressCtx, taskId: string): void {
  ctx.suppressedPlanExecDockKeysRef.current.add(ctx.planExecSuppressToken(taskId))
  ctx.setPlanExecSuppressVersion((v) => v + 1)
}
