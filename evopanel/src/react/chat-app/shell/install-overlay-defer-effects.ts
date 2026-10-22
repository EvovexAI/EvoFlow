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
  queueMicrotask(() => ctx.setSidePanelHeavyMount(false))
  const id = requestAnimationFrame(() => ctx.setSidePanelHeavyMount(true))
  return () => cancelAnimationFrame(id)
}
