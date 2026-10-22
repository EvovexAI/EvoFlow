// @ts-nocheck — mechanical P116 extract.
/**
 * Fixed positioning for bottom-more and plugin quick panel portals. Extracted (P116).
 */
export type InstallBottomPortalLayoutsCtx = Record<string, any>

export function runBottomMorePortalLayoutEffect(
  ctx: InstallBottomPortalLayoutsCtx,
): void | (() => void) {
  console.log('[ChatApp] useLayoutEffect bottomMoreOpen:', ctx.bottomMoreOpen)
  if (!ctx.bottomMoreOpen || typeof window === 'undefined') {
    console.log('[ChatApp] bottomMoreOpen 为 false 或 window 不存在，清除样式')
    ctx.setBottomMorePortalStyle(null)
    return
  }
  console.log('[ChatApp] 计算下拉菜单位置...')
  const update = () => {
    const btn = ctx.bottomMoreTriggerRef.current
    if (!btn) {
      console.log('[ChatApp] bottomMoreTriggerRef.current 为 null')
      return
    }
    console.log('[ChatApp] 按钮位置:', btn.getBoundingClientRect())
    const r = btn.getBoundingClientRect()
    const gap = 10
    const sidePad = 10
    const minW = 180
    const left = Math.max(sidePad, Math.min(r.left, window.innerWidth - sidePad - minW))
    const bottom = Math.max(sidePad, window.innerHeight - r.top + gap)
    const maxH = Math.max(120, Math.min(window.innerHeight * 0.55, r.top - gap - sidePad))
    ctx.setBottomMorePortalStyle({
      position: 'fixed',
      left,
      bottom,
      top: 'auto',
      minWidth: minW,
      maxHeight: maxH,
      zIndex: 10060,
    })
    console.log('[ChatApp] 计算的样式:', { left, bottom, maxH, minW })
  }
  update()
  console.log('[ChatApp] 初始化完成，添加事件监听')
  window.addEventListener('resize', update)
  window.addEventListener('scroll', update, true)
  return () => {
    window.removeEventListener('resize', update)
    window.removeEventListener('scroll', update, true)
  }
}

export function runPluginPanelPortalLayoutEffect(
  ctx: InstallBottomPortalLayoutsCtx,
): void | (() => void) {
  if (!ctx.bottomPluginPanelOpen || typeof window === 'undefined') {
    ctx.setPluginPanelStyle(null)
    return
  }
  const update = () => {
    const btn = ctx.bottomMoreTriggerRef.current
    if (!btn) return
    const r = btn.getBoundingClientRect()
    const gap = 10
    const sidePad = 10
    const left = Math.max(sidePad, Math.min(r.left, window.innerWidth - sidePad - 620))
    const bottom = Math.max(sidePad, window.innerHeight - r.top + gap)
    const maxH = Math.max(160, Math.min(window.innerHeight * 0.62, r.top - gap - sidePad))
    ctx.setPluginPanelStyle({
      position: 'fixed',
      left,
      bottom,
      top: 'auto',
      maxHeight: maxH,
      zIndex: 10060,
    })
  }
  update()
  window.addEventListener('resize', update)
  window.addEventListener('scroll', update, true)
  return () => {
    window.removeEventListener('resize', update)
    window.removeEventListener('scroll', update, true)
  }
}
