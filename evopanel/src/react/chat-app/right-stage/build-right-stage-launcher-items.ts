// @ts-nocheck — mechanical P108 extract.
/**
 * Default right-stage launcher items for empty stage home. Extracted (P108).
 */
export type BuildRightStageLauncherItemsCtx = Record<string, any>

export function buildChatRightStageLauncherItems(ctx: BuildRightStageLauncherItemsCtx) {
  return ctx.buildDefaultRightStageLauncherItems({
    onOpenBrowser: () => {
      const manualTid = String(
        ctx.wsClient.getSessionThreadId(ctx.selectedSessionKey || '') || '',
      ).trim()
      if (manualTid) ctx.setBrowserPanelThreadId(manualTid)
      ctx.ensureBrowserStage({
        forceNew: true,
        sessionKey: ctx.selectedSessionKey || undefined,
      })
    },
    onOpenWorkspace: () => {
      ctx.rightStageUserPinnedRef.current = 'workspace-browse'
      ctx.setWorkspacePanelOpen(true)
      ctx.setWorkspaceTreePinned(true)
      ctx.syncShellAsideForWorkspacePanel(true)
    },
    onOpenWorkflow: () => {
      ctx.openCollabExecPanel()
    },
    onOpenSummary: () => {
      ctx.setChatPanelDisplayMode('panel')
    },
    mindMapEnabled: ctx.knowledgeMapEnabled,
    onOpenMindMap: () => {
      ctx.openKnowledgeMapPanel()
    },
  })
}
