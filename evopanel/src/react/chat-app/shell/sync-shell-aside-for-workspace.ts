/**
 * Collapse left shell while workspace panel is open; restore on close.
 * Extracted from ChatApp.tsx (P35).
 */
export type SyncShellAsideForWorkspaceCtx = {
  shellCollapsedBeforeWorkspaceRef: { current: boolean | null }
  getShellAsideCollapsed: () => boolean
  setShellAsideCollapsed: (collapsed: boolean) => void
}

export function syncShellAsideForWorkspacePanel(
  ctx: SyncShellAsideForWorkspaceCtx,
  open: boolean,
): void {
  if (open) {
    if (ctx.shellCollapsedBeforeWorkspaceRef.current === null) {
      ctx.shellCollapsedBeforeWorkspaceRef.current = ctx.getShellAsideCollapsed()
    }
    ctx.setShellAsideCollapsed(true)
    return
  }
  if (ctx.shellCollapsedBeforeWorkspaceRef.current !== null) {
    ctx.setShellAsideCollapsed(ctx.shellCollapsedBeforeWorkspaceRef.current)
    ctx.shellCollapsedBeforeWorkspaceRef.current = null
  }
}
