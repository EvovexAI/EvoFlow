// @ts-nocheck — mechanical P111 extract.
/**
 * Outside-click / Esc dismiss for bottom mode/model/permission/more menus. Extracted (P111).
 */
export type InstallBottomMenusDismissCtx = Record<string, any>

export function runBottomMenusDismissEffect(
  ctx: InstallBottomMenusDismissCtx,
): void | (() => void) {
  const anyOpen =
    ctx.modeMenuOpen ||
    ctx.bottomModelOpen ||
    ctx.bottomPermissionOpen ||
    ctx.bottomMoreOpen ||
    ctx.bottomWorkspaceOpen ||
    ctx.bottomPluginPanelOpen
  if (!anyOpen) return
  const closeAll = () => {
    ctx.setModeMenuOpen(false)
    ctx.setBottomModelOpen(false)
    ctx.setBottomPermissionOpen(false)
    ctx.setBottomMoreOpen(false)
    ctx.setMoreSubOpen(null)
    ctx.setBottomWorkspaceOpen(false)
    ctx.setBottomRoleOpen(false)
    ctx.setBottomSkillOpen(false)
    ctx.setBottomPluginPanelOpen(false)
  }
  const onDown = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null
    if (!target) return
    // 模式菜单 portal 到 body，需单独识别
    if (target.closest('.react-chat-mode-menu--portal')) return
    if (ctx.bottomModelRootRef.current?.contains(target)) return
    if (ctx.bottomPermissionRootRef.current?.contains(target)) return
    // 模型菜单 / 右侧 flyout portal 到 body，需单独识别
    if (target.closest('.react-chat-bottom-dropdown--model-portal')) return
    if (target.closest('.react-chat-model-flyout-portal')) return
    if (target.closest('.react-chat-bottom-dropdown--permission-portal')) return
    if (target.closest('.react-chat-permission-card--portal')) return
    if (ctx.bottomMoreRootRef.current?.contains(target)) return
    // 「更多」菜单 portal 到 body，需单独识别
    if (target.closest('.react-chat-bottom-dropdown--more-portal')) return
    // + 号按钮（v4 加号触发附件/更多下拉）也算「更多」菜单入口
    if (target.closest('.react-chat-icon-attach-btn')) return
    // 权限 pill（v4 风格点 pill 弹三选一菜单）
    if (target.closest('.react-chat-bottom-permission-pill')) return
    // 权限三选一上拉菜单本身（v4 新位置，不 portal）
    if (target.closest('.react-chat-permission-menu')) return
    if (ctx.bottomWorkspaceRootRef.current?.contains(target)) return
    closeAll()
  }
  document.addEventListener('mousedown', onDown)
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') closeAll()
  }
  document.addEventListener('keydown', onKey)
  return () => {
    document.removeEventListener('mousedown', onDown)
    document.removeEventListener('keydown', onKey)
  }
}
