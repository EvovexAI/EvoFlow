// @ts-nocheck — mechanical P142 extract.
/**
 * Set chat summary display mode and collapse right stage when opening panel.
 * Extracted from ChatApp.tsx (P142).
 */
export type SetChatPanelDisplayModeCtx = Record<string, any>

export function setChatPanelDisplayMode(
  ctx: SetChatPanelDisplayModeCtx,
  mode: string,
): void {
  ctx.setChatPanelMode(mode)
  ctx.saveChatSummaryDisplayMode(mode)
  if (mode === 'panel') {
    // 悬浮卡与专用侧栏互斥：展开卡片时关掉侧栏。
    ctx.collapseRightStage()
  }
}
