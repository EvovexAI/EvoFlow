// @ts-nocheck — mechanical P108 extract.
/**
 * Default right-stage launcher items for empty stage home. Extracted (P108).
 */
export type BuildRightStageLauncherItemsCtx = Record<string, any>

export function buildChatRightStageLauncherItems(ctx: BuildRightStageLauncherItemsCtx) {
  return ctx.buildDefaultRightStageLauncherItems({
    onOpenXiaomi: () => {
      ctx.rightStageUserPinnedRef.current = 'xiaomi'
      void import('../../../lib/right-stage/open-right-stage-xiaomi.js').then((m) =>
        m.openXiaomiRightStage({ navigateToChat: false }),
      )
    },
    // 实际开签由 RightStagePanel 选员工后走 onPickEmployeeChat
    onOpenEmployeeChat: () => {},
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
    // 「Agent 应用」入口：点它进选择器（RightStagePanel.onPickAgentApp），
    // 真正开签由 onPickAgentApp → openUiExtensionInStage 完成。
    // 这里只保证入口存在；onOpen 兜底直开第一个已安装应用。
    onOpenAgentApp: () => {
      ctx.openAgentAppLauncher?.()
    },
  })
}
