// @ts-nocheck — mechanical P105 extract.
/**
 * Overlay defer flags + side-panel heavy mount rAF. Extracted from ChatApp.tsx (P105).
 */
export type OverlayDeferEffectsCtx = Record<string, any>

export function runChatOverlayDeferEffect(ctx: OverlayDeferEffectsCtx): void {
  const knowledgeMapVisible = ctx.knowledgeMapEnabled && ctx.knowledgeMapPanelOpen
  // 右栏文件/终端与对话并排，取消 bump 会冻住流式绘制并在恢复时跳动；
  // 仅遮罩对话区的侧栏才暂停 bump。
  const coveringOverlay =
    ctx.workspacePanelOpen || knowledgeMapVisible || ctx.collabExecPanelOpen
  ctx.setChatOverlayDefer('workspace', ctx.workspacePanelOpen)
  ctx.setChatOverlayDefer('knowledge-map', knowledgeMapVisible)
  ctx.setChatOverlayDefer('workflow', ctx.collabExecPanelOpen)
  ctx.setChatOverlayDefer('file-preview', false)
  if (coveringOverlay) {
    ctx.cancelPendingStreamUiBumpsRef.current()
  }
}

export function runSidePanelHeavyMountEffect(
  ctx: OverlayDeferEffectsCtx,
): void | (() => void) {
  const knowledgeMapVisible = ctx.knowledgeMapEnabled && ctx.knowledgeMapPanelOpen
  const anySidePanelOpen =
    ctx.rightStageOpen ||
    ctx.workspacePanelOpen ||
    knowledgeMapVisible ||
    ctx.collabExecPanelOpen
  if (!anySidePanelOpen) {
    queueMicrotask(() => ctx.setSidePanelHeavyMount(false))
    return
  }
  // 冷开：首帧保持 boot shell，下一帧再挂重面板。
  // 已开着时切 write / workflow 等依赖 → 禁止再 false→true，否则 file/Python
  // 预览会整页卸载重挂（侧栏闪烁、像在频繁刷新）。
  const id = requestAnimationFrame(() => ctx.setSidePanelHeavyMount(true))
  return () => cancelAnimationFrame(id)
}
