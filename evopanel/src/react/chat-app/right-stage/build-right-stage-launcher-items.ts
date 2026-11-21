// @ts-nocheck — mechanical P108 extract.
/**
 * Default right-stage launcher items for empty stage home. Extracted (P108).
 */
import { rightStageStore } from '../../../lib/right-stage/right-stage-store.js'
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
    onOpenTerminal: () => {
      const cwd = String(ctx.effectiveWorkspaceRoot || '').trim()
      const threadId = String(
        ctx.wsClient?.getSessionThreadId?.(ctx.selectedSessionKey || '') ||
          ctx.chatThreadIdForSidebar ||
          '',
      ).trim()
      const title =
        (cwd && cwd.split(/[\\/]/).filter(Boolean).pop()) || '终端'
      void import('../../../lib/right-stage/ensure-interactive-terminal-stage.js').then((m) => {
        m.ensureInteractiveTerminalStage({
          cwd,
          threadId,
          title,
          sessionKey: ctx.selectedSessionKey || undefined,
          forceNew: true,
        })
      })
    },
    onOpenWorkflow: () => {
      ctx.openCollabExecPanel()
    },
    // 【2026-11-21 · 第104轮】摘要已迁到对话正文右上角（见
    // set-chat-panel-display-mode.ts 与 RightStagePanel 的 FORCE_MOUNT_KINDS 注释：
    // 「summary：chat 渲染面里恒返回 null（死载荷），2026-11-05 收敛移除」）。
    // 这里原本调 ctx.setChatPanelDisplayMode('panel')：右栏开着时它什么都不做
    // （showChatSummaryFloat 要求 !rightStageOpen），于是在「+ 打开新标签」里
    // 表现为点了没反应的死入口。改为收起右栏并切到摘要卡，点了必然有可见反馈。
    onOpenSummary: () => {
      ctx.setChatPanelDisplayMode('panel')
      rightStageStore.collapse()
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
