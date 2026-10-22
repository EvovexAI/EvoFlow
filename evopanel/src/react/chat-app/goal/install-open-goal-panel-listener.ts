// @ts-nocheck — mechanical P104 extract.
/**
 * Window listener for open-goal-panel + pending sessionStorage flag. Extracted (P104).
 */
export type InstallOpenGoalPanelListenerCtx = Record<string, any>

export function runOpenGoalPanelListenerEffect(
  ctx: InstallOpenGoalPanelListenerCtx,
): () => void {
  const { goal } = ctx
  const onOpenGoalPanel = (event: Event) => {
    const detail = (event as CustomEvent<{ open?: boolean }>).detail
    if (typeof detail?.open === 'boolean') {
      goal.goal.setPanelOpen(detail.open)
      return
    }
    goal.goal.setPanelOpen((v: boolean) => !v)
  }
  window.addEventListener('evopanel:open-goal-panel', onOpenGoalPanel as EventListener)
  // 从其它路由点击悬浮宠物跳转到 /chat 后，自动弹出目标面板
  try {
    if (sessionStorage.getItem('evopanel-open-goal-panel') === '1') {
      sessionStorage.removeItem('evopanel-open-goal-panel')
      goal.goal.setPanelOpen(true)
    }
  } catch {
    /* ignore */
  }
  return () => window.removeEventListener('evopanel:open-goal-panel', onOpenGoalPanel as EventListener)
}
