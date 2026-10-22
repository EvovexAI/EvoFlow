// @ts-nocheck — mechanical P90 extract.
/**
 * Chat summary / employee / task float panel. Extracted from ChatApp.tsx (P90).
 */
import type { ReactNode } from 'react'
import { ChatSummaryPanel } from '../../components/ChatSummaryPanel.js'
import { EmployeePane, TaskPane } from '../../components/ChatWorkspaceInfoRail.js'

export type RenderChatSummaryPanelCtx = Record<string, any>

export function renderChatSummaryPanel(
  ctx: RenderChatSummaryPanelCtx,
  mode: 'panel' | 'capsule',
): ReactNode {
  const {
    artifactFocusId,
    assetQuickBusy,
    capabilityPatchBusy,
    currentAgentCapabilities,
    currentRoleAgent,
    currentRoleCodeForUi,
    currentRoleLabel,
    displayContextUsage,
    effectiveModelName,
    employeeRoleDetail,
    employeeSessionAgentCode,
    getDisplayLabel,
    handleAssetQuickAction,
    handleManualContextCompact,
    handleOpenProcessItem,
    handleStopProcessItem,
    headerTokenTotals,
    isProactiveEmployeeSession,
    liveProcessSnapshot,
    manualContextCompacting,
    modelPillLabel,
    obsEnabled,
    openCurrentAgentEditor,
    openSessionArtifact,
    patchCurrentAgentCapabilities,
    platformFocusEntryId,
    revealSessionArtifact,
    selectedSessionKey,
    selectedThreadId,
    selectedTurnBusy,
    sessionArtifacts,
    sessionPlatformEntries,
    sessions,
    setBottomRoleOpen,
    setChatPanelDisplayMode,
    sharedCollabSubtasks,
    sidebarActiveView,
    turnArtifacts,
    turnPlatformEntries,
  } = ctx
  return (
    <ChatSummaryPanel
      displayMode={mode}
      onDisplayModeChange={setChatPanelDisplayMode}
      isRunning={selectedTurnBusy}
      sessionTitle={getDisplayLabel(
        selectedSessionKey,
        sessions.find((s) => String(s.sessionKey || '') === String(selectedSessionKey || ''))?.title,
      )}
      terminalStreams={liveProcessSnapshot.terminalStreams}
      subagentTasks={liveProcessSnapshot.subagentTasks}
      workflowSubtasks={sharedCollabSubtasks}
      backgroundWorks={liveProcessSnapshot.backgroundWorks}
      onOpenProcessItem={handleOpenProcessItem}
      onStopProcessItem={handleStopProcessItem}
      agentLabel={currentRoleLabel}
      modelLabel={modelPillLabel}
      modelName={effectiveModelName}
      agentCode={
        isProactiveEmployeeSession
          ? employeeSessionAgentCode || currentRoleCodeForUi
          : currentRoleCodeForUi
      }
      agentDescription={String(currentRoleAgent?.description || '').trim()}
      agent={currentRoleAgent}
      skillNames={currentAgentCapabilities.skillNames}
      toolNames={currentAgentCapabilities.toolNames}
      mcpServers={currentAgentCapabilities.mcpServers}
      knowledgeVaultIds={
        isProactiveEmployeeSession
          ? employeeRoleDetail?.knowledgeVaultIds || []
          : currentAgentCapabilities.knowledgeVaultIds
      }
      onPatchCapabilities={patchCurrentAgentCapabilities}
      capabilityBusy={capabilityPatchBusy}
      onSwitchAgent={
        isProactiveEmployeeSession ? undefined : () => setBottomRoleOpen(true)
      }
      onEditAgent={currentRoleCodeForUi || employeeSessionAgentCode ? openCurrentAgentEditor : undefined}
      onAssetQuickAction={handleAssetQuickAction}
      assetQuickBusy={assetQuickBusy}
      artifacts={sessionArtifacts}
      recentArtifacts={turnArtifacts}
      artifactFocusId={artifactFocusId}
      platformEntries={sessionPlatformEntries}
      recentPlatformEntries={turnPlatformEntries}
      platformFocusEntryId={platformFocusEntryId}
      onOpenArtifact={openSessionArtifact}
      onRevealArtifact={revealSessionArtifact}
      obsEnabled={obsEnabled}
      threadId={selectedThreadId}
      isEmployeeSession={isProactiveEmployeeSession}
      employeePane={
        isProactiveEmployeeSession ? (
          <EmployeePane
            employeeInfo={employeeRoleDetail}
            sessionTitle={getDisplayLabel(selectedSessionKey, '')}
            isRunning={selectedTurnBusy}
            agentLabel={currentRoleLabel}
            modelLabel={modelPillLabel}
            agentCode={employeeSessionAgentCode || currentRoleCodeForUi}
            agentDescription={String(currentRoleAgent?.description || '').trim()}
            agent={currentRoleAgent}
            skillNames={currentAgentCapabilities.skillNames}
            toolNames={currentAgentCapabilities.toolNames}
            mcpServers={currentAgentCapabilities.mcpServers}
            knowledgeVaultIds={
              employeeRoleDetail?.knowledgeVaultIds ||
              currentAgentCapabilities.knowledgeVaultIds
            }
            onPatchCapabilities={patchCurrentAgentCapabilities}
            capabilityBusy={capabilityPatchBusy}
            modelName={effectiveModelName}
            contextUsage={displayContextUsage}
            tokenTotals={headerTokenTotals}
            onManualCompact={handleManualContextCompact}
            manualCompactDisabled={manualContextCompacting}
            onEditAgent={openCurrentAgentEditor}
            onAssetQuickAction={handleAssetQuickAction}
            assetQuickBusy={assetQuickBusy}
          />
        ) : null
      }
      taskPane={
        isProactiveEmployeeSession ? (
          <TaskPane
            sessionTitle={getDisplayLabel(selectedSessionKey, '')}
            isRunning={selectedTurnBusy}
            tokenTotals={headerTokenTotals}
            agentCode={employeeSessionAgentCode || currentRoleCodeForUi}
            sessionKey={String(selectedSessionKey || '')}
            liveTask={sidebarActiveView?.task || null}
          />
        ) : null
      }
    />
  )
}
