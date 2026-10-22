// @ts-nocheck — mechanical P144 extract.
/**
 * On selectedSessionKey change: reset user-closed flag and open info rail (unless user closed).
 * Extracted from ChatApp.tsx (P144).
 */
export type RunInfoRailOnSessionChangeCtx = Record<string, any>

export function runInfoRailOnSessionChangeEffect(ctx: RunInfoRailOnSessionChangeCtx): void {
  const sessionKeyChanged =
    ctx.prevSelectedSessionKeyForInfoRailRef.current !== ctx.selectedSessionKey
  ctx.prevSelectedSessionKeyForInfoRailRef.current = ctx.selectedSessionKey
  if (sessionKeyChanged) {
    ctx.userClosedInfoRailRef.current = false
  }
  if (ctx.userClosedInfoRailRef.current) {
    // 用户在当前会话主动关过：尊重意图，保持关闭，仅同步 tab。
    ctx.setInfoRailTab(ctx.isProactiveEmployeeSession ? 'task' : 'agent')
    return
  }
  ctx.setInfoRailOpen(true)
  ctx.setInfoRailTab(ctx.isProactiveEmployeeSession ? 'task' : 'agent')
}
